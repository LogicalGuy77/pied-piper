"""Export a Hugging Face Llama-family model into the swarm weight format.

Writes raw little-endian files, one per layer, plus the embedding table and
final norm, and a manifest.json listing every tensor's name, shape, dtype and
byte offset. A phone serving layers [a, b) downloads only the files it needs.
Linear weights keep PyTorch's [out, in] row-major layout, so y = W @ x is one
dot product per row.

With --dtype int8, every matrix (the linear weights and the embedding table)
is stored as int8 with one float32 scale per row: W[r] = q[r] * scale[r],
scale[r] = max |W[r]| / 127. Norm weights stay float32. Files are a quarter
of the size.

    .venv/bin/python reference/export.py
    .venv/bin/python reference/export.py --dtype int8
"""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import torch
from huggingface_hub import hf_hub_download
from transformers import AutoModelForCausalLM, AutoTokenizer

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MODEL = "HuggingFaceTB/SmolLM2-135M-Instruct"
DEFAULT_OUT = ROOT / "weights" / "smollm2-135m-instruct"
DEFAULT_OUT_INT8 = ROOT / "weights" / "smollm2-135m-instruct-int8"

# Tensor order inside each layer file: our name -> Hugging Face key under model.layers.{i}
LAYER_TENSORS = {
    "input_layernorm": "input_layernorm.weight",
    "q_proj": "self_attn.q_proj.weight",
    "k_proj": "self_attn.k_proj.weight",
    "v_proj": "self_attn.v_proj.weight",
    "o_proj": "self_attn.o_proj.weight",
    "post_attention_layernorm": "post_attention_layernorm.weight",
    "gate_proj": "mlp.gate_proj.weight",
    "up_proj": "mlp.up_proj.weight",
    "down_proj": "mlp.down_proj.weight",
}


def load_hf_model(model_name):
    return AutoModelForCausalLM.from_pretrained(model_name, dtype=torch.float32, attn_implementation="eager").eval()


def read_raw_config(model_name):
    local = Path(model_name)
    path = local / "config.json" if local.is_dir() else hf_hub_download(model_name, "config.json")
    return json.loads(Path(path).read_text())


def model_config(raw):
    """The subset of config.json the stage engine needs, after checking we support it."""
    problems = []
    if raw.get("model_type") != "llama":
        problems.append(f"model_type is {raw.get('model_type')!r}, only 'llama' is supported")
    if raw.get("hidden_act", "silu") != "silu":
        problems.append(f"hidden_act is {raw['hidden_act']!r}, only 'silu' is supported")
    if raw.get("attention_bias") or raw.get("mlp_bias"):
        problems.append("biases in attention or MLP are not supported")
    if raw.get("rope_scaling"):
        problems.append(f"rope_scaling {raw['rope_scaling']} is not supported")
    if problems:
        raise SystemExit("Cannot export this model:\n  " + "\n  ".join(problems))

    heads = raw["num_attention_heads"]
    return {
        "hidden_size": raw["hidden_size"],
        "intermediate_size": raw["intermediate_size"],
        "num_layers": raw["num_hidden_layers"],
        "num_heads": heads,
        "num_kv_heads": raw.get("num_key_value_heads", heads),
        "head_dim": raw.get("head_dim") or raw["hidden_size"] // heads,
        "vocab_size": raw["vocab_size"],
        "rms_norm_eps": raw["rms_norm_eps"],
        "rope_theta": raw.get("rope_theta", 10000.0),
        "max_position_embeddings": raw["max_position_embeddings"],
        "tie_word_embeddings": raw.get("tie_word_embeddings", False),
        "bos_token_id": raw.get("bos_token_id"),
        "eos_token_id": raw.get("eos_token_id"),
    }


def chat_profile(tokenizer):
    """How this model's chat template lays out a conversation, for the browser tokenizer.

    swarm/src/tokenizer.js renders ChatML itself (no Jinja on the phone), so
    this renders the Hugging Face template on probe conversations and reads
    off the pieces that differ between models: the text before everything
    (a BOS token, say), the default system message if the template adds one,
    and what follows "<|im_start|>assistant\\n", both when generating and in
    past turns (hybrid-thinking models put an empty think block there).
    Thinking is switched off, so the swarm's answers start right away.
    """
    def render(messages):
        return tokenizer.apply_chat_template(messages, add_generation_prompt=True, tokenize=False, enable_thinking=False)

    def turn(role, content):
        return f"<|im_start|>{role}\n{content}<|im_end|>\n"

    user, open_assistant = turn("user", "Q?"), "<|im_start|>assistant\n"
    core = user + open_assistant

    def fail(what):
        raise SystemExit(f"Cannot export this model: its chat template is not ChatML ({what}), "
                         "so swarm/src/tokenizer.js could not render it")

    one = render([{"role": "user", "content": "Q?"}])
    i = one.find(core)
    if i < 0:
        fail("no user turn followed by an assistant turn")
    head, assistant_prefix = one[:i], one[i + len(core):]

    with_system = render([{"role": "system", "content": "S."}, {"role": "user", "content": "Q?"}])
    j = with_system.find(turn("system", "S.") + core)
    if j < 0 or with_system[j + len(turn("system", "S.") + core):] != assistant_prefix:
        fail("a system message is not rendered as a system turn")
    bos = with_system[:j]
    if not head.startswith(bos):
        fail("the text before the first turn changes with a system message")
    default_system = head[len(bos):]
    if default_system:
        if not (default_system.startswith("<|im_start|>system\n") and default_system.endswith("<|im_end|>\n")):
            fail("the default system message is not a system turn")
        default_system = default_system[len("<|im_start|>system\n"):-len("<|im_end|>\n")]

    history = render([{"role": "user", "content": "Q?"}, {"role": "assistant", "content": "A."},
                      {"role": "user", "content": "R?"}])
    k = history.find(core)
    tail = "A.<|im_end|>\n" + turn("user", "R?") + open_assistant + assistant_prefix
    if k < 0 or not history.endswith(tail):
        fail("a past assistant turn is not rendered as an assistant turn")
    history_prefix = history[k + len(core):-len(tail)]

    return {
        "format": "chatml",
        "bos": bos,
        "system": default_system or None,
        "assistant_prefix": assistant_prefix,
        "assistant_history_prefix": history_prefix,
    }


def quantize_rows(w):
    """Symmetric int8 per row: returns (q int8 [rows, cols], scale float32 [rows])."""
    w = np.asarray(w, dtype=np.float32)
    scale = (np.abs(w).max(axis=1) / np.float32(127)).astype(np.float32)
    scale[scale == 0] = 1
    q = np.clip(np.rint(w / scale[:, None]), -127, 127).astype(np.int8)
    return q, scale


def write_file(out_dir, filename, tensors, dtype="float32"):
    """Write [(name, array)] back to back into one file; return its manifest entry.

    With dtype "int8", 2-D tensors are written as int8 values followed by
    their float32 row scales; 1-D tensors (norms) stay float32. Every tensor
    starts at a multiple of 4 bytes, so float32 views need no copy.
    """
    entry = {"file": filename, "tensors": []}
    digest = hashlib.sha256()
    offset = 0
    with open(out_dir / filename, "wb") as f:

        def put(data):
            nonlocal offset
            data += b"\0" * (-len(data) % 4)
            f.write(data)
            digest.update(data)
            start, offset = offset, offset + len(data)
            return start

        for name, array in tensors:
            if dtype == "int8" and array.ndim == 2:
                q, scale = quantize_rows(array)
                t = {"name": name, "shape": list(array.shape), "dtype": "int8", "offset": put(q.tobytes())}
                t["scale_offset"] = put(np.ascontiguousarray(scale, dtype="<f4").tobytes())
            else:
                data = np.ascontiguousarray(array, dtype="<f4").tobytes()
                t = {"name": name, "shape": list(array.shape), "dtype": "float32", "offset": put(data)}
            entry["tensors"].append(t)
    entry["bytes"] = offset
    entry["sha256"] = digest.hexdigest()
    return entry


def main():
    ap = argparse.ArgumentParser(description="Export a Hugging Face model into per-layer weight files.")
    ap.add_argument("--model", default=DEFAULT_MODEL, help="Hugging Face model id or local directory")
    ap.add_argument("--dtype", choices=["float32", "int8"], default="float32")
    ap.add_argument("--out", type=Path, help="output directory (default: weights/<model>[-int8])")
    args = ap.parse_args()
    if args.out is None:
        name = args.model.rstrip("/").split("/")[-1].lower()
        args.out = ROOT / "weights" / (name + ("-int8" if args.dtype == "int8" else ""))
    dtype = args.dtype

    config = model_config(read_raw_config(args.model))
    tokenizer = AutoTokenizer.from_pretrained(args.model)
    chat = chat_profile(tokenizer)
    eos = config["eos_token_id"]
    chat["stop_ids"] = sorted({*(eos if isinstance(eos, list) else [eos]), tokenizer.convert_tokens_to_ids("<|im_end|>")})
    print(f"Loading {args.model} in float32 ...")
    sd = load_hf_model(args.model).state_dict()

    def tensor(key):
        return sd[key].detach().numpy()

    args.out.mkdir(parents=True, exist_ok=True)
    layers = [
        write_file(args.out, f"layer_{i:02d}.bin",
                   [(name, tensor(f"model.layers.{i}.{key}")) for name, key in LAYER_TENSORS.items()], dtype)
        for i in range(config["num_layers"])
    ]
    embed = write_file(args.out, "embed.bin", [("embed_tokens", tensor("model.embed_tokens.weight"))], dtype)
    final_norm = write_file(args.out, "final_norm.bin", [("norm", tensor("model.norm.weight"))], dtype)
    lm_head = None
    if not config["tie_word_embeddings"]:
        lm_head = write_file(args.out, "lm_head.bin", [("lm_head", tensor("lm_head.weight"))], dtype)

    manifest = {
        "format": "swarm-weights/1",
        "source": args.model,
        "dtype": dtype,
        "byte_order": "little",
        "layout": "row-major; linear weights are [out, in], so y = W @ x"
                  + ("; int8 tensors are q[out, in] then float32 scale[out], W = q * scale[:, None]"
                     if dtype == "int8" else ""),
        "config": config,
        "chat": chat,  # the chat template's ChatML pieces, for swarm/src/tokenizer.js
        "embed": embed,
        "final_norm": final_norm,
        "lm_head": lm_head,  # null means the output layer reuses the embedding table
        "layers": layers,
    }
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    tokenizer.save_pretrained(args.out / "tokenizer")

    mb = 1e6
    total = sum(e["bytes"] for e in [embed, final_norm, *layers] + ([lm_head] if lm_head else []))
    print(f"Wrote {args.out.relative_to(ROOT) if args.out.is_relative_to(ROOT) else args.out}/")
    print(f"  {len(layers)} layer files   {layers[0]['bytes'] / mb:6.1f} MB each")
    print(f"  embed.bin        {embed['bytes'] / mb:6.1f} MB" + ("  (also the output layer)" if lm_head is None else ""))
    if lm_head:
        print(f"  lm_head.bin      {lm_head['bytes'] / mb:6.1f} MB")
    print(f"  final_norm.bin   {final_norm['bytes'] / 1e3:6.1f} KB")
    print(f"  total            {total / mb:6.1f} MB")
    print("  manifest.json, tokenizer/")


if __name__ == "__main__":
    main()

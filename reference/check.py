"""Step 1 checks: is the reference stage engine correct, and does splitting change anything?

1. The exported files are intact and equal Hugging Face's weights bit for bit.
2. The unsplit NumPy engine matches Hugging Face: hidden states after every
   layer, logits, and greedy tokens.
3. Every way of splitting the model into stages gives bit-identical logits
   to the unsplit run.
4. Feeding the prompt in one pass or one token at a time gives the same answer.
5. Interleaved sessions on shared stages don't affect each other.

Then writes testvectors/ for the step-2 JavaScript engine.

    .venv/bin/python reference/check.py
"""

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch
from transformers import AutoTokenizer

from export import DEFAULT_OUT, LAYER_TENSORS, ROOT, load_hf_model
from pipeline import Pipeline, generate, generate_stream
from stage import Stage, load_manifest, read_file

PROMPT = "Explain in two sentences why the sky is blue."
PROMPT_B = "Name three things a phone can do."

# float32 on two different libraries never agrees exactly; these are generous
# bounds that still catch any real bug (a wrong RoPE or mask is off by > 0.1).
TOL_HIDDEN_REL = 1e-4   # max |ours - hf| / max |hf| per layer boundary
TOL_LOGITS_ABS = 2e-3   # max |ours - hf| over all vocab entries

results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail else ""))
    return ok


def chat_ids(tokenizer, text):
    # Thinking off, as on the phones: hybrid models (MiniCPM5, Qwen3) then answer right away.
    enc = tokenizer.apply_chat_template([{"role": "user", "content": text}], add_generation_prompt=True,
                                        enable_thinking=False)
    return list(enc if isinstance(enc, list) else enc["input_ids"])


def splits_for(n_layers):
    L = n_layers
    return [
        [0, L],
        [0, 8, L - 8, L],             # the 3-block layout on the architecture page
        [0, L // 3, 2 * L // 3, L],
        [0, L // 2, L],
        [0, 1, L - 1, L],
        list(range(L + 1)),           # one layer per stage
    ]


def fmt(boundaries):
    return "[" + ",".join(map(str, boundaries)) + "]" if len(boundaries) <= 6 else f"[0,1,...,{boundaries[-1]}]"


def hf_prefill(model, ids):
    """Hidden state after the embedding and after every layer, plus logits."""
    captured = []

    def hook(module, inputs, output):
        out = output[0] if isinstance(output, tuple) else output
        captured.append(out.detach()[0].numpy().copy())

    handles = [model.model.embed_tokens.register_forward_hook(hook)]
    handles += [layer.register_forward_hook(hook) for layer in model.model.layers]
    with torch.no_grad():
        logits = model(torch.tensor([ids])).logits[0].numpy()
    for h in handles:
        h.remove()
    return captured, logits


def hf_generate(model, ids, max_new, eos_id):
    x = torch.tensor([ids])
    with torch.no_grad():
        out = model.generate(x, attention_mask=torch.ones_like(x), max_new_tokens=max_new, do_sample=False,
                             pad_token_id=eos_id, return_dict_in_generate=True, output_scores=True)
    return out.sequences[0, len(ids):].tolist(), [s[0].numpy() for s in out.scores]


def files_intact(weights, manifest):
    entries = [manifest["embed"], manifest["final_norm"], *manifest["layers"]]
    if manifest["lm_head"]:
        entries.append(manifest["lm_head"])
    for e in entries:
        if hashlib.sha256((weights / e["file"]).read_bytes()).hexdigest() != e["sha256"]:
            return False, f"{e['file']} does not match its sha256"
    return True, f"{len(entries)} files"


def export_matches(weights, manifest, sd):
    pairs = [(manifest["embed"], {"embed_tokens": "model.embed_tokens.weight"}),
             (manifest["final_norm"], {"norm": "model.norm.weight"})]
    if manifest["lm_head"]:
        pairs.append((manifest["lm_head"], {"lm_head": "lm_head.weight"}))
    for i, entry in enumerate(manifest["layers"]):
        pairs.append((entry, {name: f"model.layers.{i}.{key}" for name, key in LAYER_TENSORS.items()}))
    for entry, names in pairs:
        tensors = read_file(weights, entry)
        for name, key in names.items():
            if not np.array_equal(tensors[name], sd[key].numpy()):
                return False, f"{entry['file']}:{name} differs from {key}"
    return True, f"{sum(len(n) for _, n in pairs)} tensors"


def write_testvectors(out_dir, weights, manifest, prompt, prompt_ids, tokens, answer, split, n_decode=3,
                      source="reference/stage.py, checked against Hugging Face by reference/check.py"):
    """Reference outputs for the JS engine: h at every layer boundary, and logits."""
    out_dir.mkdir(parents=True, exist_ok=True)
    stage = Stage(weights, 0, manifest["config"]["num_layers"])
    files = []

    def save(name, array, description):
        array = np.ascontiguousarray(array, dtype="<f4")
        (out_dir / name).write_bytes(array.tobytes())
        files.append({"file": name, "dtype": "float32", "shape": list(array.shape), "description": description})

    trace = []
    logits = stage.forward("tv", prompt_ids, 0, trace=trace)
    save("prefill_hidden.bin", np.stack(trace),
         "Prefill of the whole prompt. [0] is the embedding output, [i] is the output of layer i-1.")
    save("prefill_logits_last.bin", logits[-1], "Logits at the last prompt position.")

    pos = len(prompt_ids)
    hidden, step_logits, steps = [], [], []
    for k, token in enumerate(tokens[:n_decode]):
        trace = []
        lg = stage.forward("tv", [token], pos + k, trace=trace)
        hidden.append(np.stack(trace)[:, 0, :])
        step_logits.append(lg[0])
        steps.append({"token": token, "pos": pos + k})
    save("decode_hidden.bin", np.stack(hidden),
         "One row per decode step in decode_steps, each fed after the prefill using the KV cache. "
         "Same boundary layout as prefill_hidden.")
    save("decode_logits.bin", np.stack(step_logits), "Logits for each decode step.")

    index = {
        "source": source,
        "model": manifest["source"],
        "weights": str(weights.relative_to(ROOT)) if weights.is_relative_to(ROOT) else str(weights),
        "prompt": prompt,
        "prompt_ids": prompt_ids,
        "decode_steps": steps,
        "greedy_tokens": tokens,
        "greedy_tokens_note": f"Greedy output for the prompt; identical for every split, e.g. {split}.",
        "greedy_text": answer,
        "tolerance": {"hidden_rel": TOL_HIDDEN_REL, "logits_abs": TOL_LOGITS_ABS},
        "files": files,
    }
    (out_dir / "index.json").write_text(json.dumps(index, indent=2) + "\n")
    return sum((out_dir / f["file"]).stat().st_size for f in files)


def main():
    ap = argparse.ArgumentParser(description="Step 1 correctness checks.")
    ap.add_argument("--weights", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--max-new", type=int, default=40, help="tokens to generate per run")
    ap.add_argument("--testvectors", type=Path, default=ROOT / "testvectors")
    args = ap.parse_args()
    t_start = time.time()

    weights = args.weights
    manifest = load_manifest(weights)
    L = manifest["config"]["num_layers"]
    eos = manifest["config"]["eos_token_id"]
    stop_ids = set(eos if isinstance(eos, list) else [eos])
    tokenizer = AutoTokenizer.from_pretrained(weights / "tokenizer")
    prompt_ids = chat_ids(tokenizer, PROMPT)
    hf = load_hf_model(manifest["source"])

    print("\n1. Exported weights")
    check("files match the sha256 in manifest.json", *files_intact(weights, manifest))
    check("tensors equal Hugging Face's weights bit for bit", *export_matches(weights, manifest, hf.state_dict()))

    print(f"\n2. Unsplit NumPy engine vs Hugging Face  (prompt: {len(prompt_ids)} tokens)")
    hf_hidden, hf_logits = hf_prefill(hf, prompt_ids)
    trace = []
    ref_logits = Stage(weights, 0, L).forward("prefill", prompt_ids, 0, trace=trace)
    rel = [float(np.abs(ours - theirs).max() / np.abs(theirs).max()) for ours, theirs in zip(trace, hf_hidden)]
    worst = int(np.argmax(rel))  # np.max and np.argmax propagate NaN; Python's max() would skip it
    label = "embedding" if worst == 0 else f"layer {worst - 1}"
    check(f"hidden state after the embedding and all {L} layers",
          len(trace) == len(hf_hidden) and np.max(rel) < TOL_HIDDEN_REL,
          f"worst relative error {np.max(rel):.1e}, after {label}")
    check(f"prefill logits at all {len(prompt_ids)} positions", np.abs(ref_logits - hf_logits).max() < TOL_LOGITS_ABS,
          f"max abs diff {np.abs(ref_logits - hf_logits).max():.1e}")

    hf_tokens, hf_scores = hf_generate(hf, prompt_ids, args.max_new, min(stop_ids))
    base_tokens, base_logits = generate(Pipeline(weights, [0, L]), "s", prompt_ids, args.max_new, stop_ids)
    check("greedy tokens identical to Hugging Face generate()", base_tokens == hf_tokens, f"{len(hf_tokens)} tokens")
    if len(hf_scores) == len(base_logits):
        diff = float(np.max([np.abs(a - b).max() for a, b in zip(base_logits, hf_scores)]))
        check("logits at every decode step (KV cache path)", diff < TOL_LOGITS_ABS, f"max abs diff {diff:.1e}")
    print(f"        answer: {tokenizer.decode(base_tokens, skip_special_tokens=True)!r}")

    print("\n3. Split into stages vs unsplit  (h crosses each boundary as raw float32 bytes)")
    for b in splits_for(L)[1:]:
        tokens, logits = generate(Pipeline(weights, b), "s", prompt_ids, args.max_new, stop_ids)
        same = tokens == base_tokens and all(np.array_equal(x, y) for x, y in zip(logits, base_logits))
        check(f"split {fmt(b)}: same tokens, bit-identical logits", same, f"{len(b) - 1} stages")

    arch = splits_for(L)[1]
    print(f"\n4. Prompt in one pass vs one token at a time  (split {fmt(arch)})")
    tokens, logits = generate(Pipeline(weights, arch), "s", prompt_ids, args.max_new, stop_ids, prefill="one_by_one")
    diff = float(np.max([np.abs(x - y).max() for x, y in zip(logits, base_logits)]))
    check("same tokens", tokens == base_tokens)
    check("logits within tolerance", diff < TOL_LOGITS_ABS, f"max abs diff {diff:.1e}")

    print(f"\n5. Sessions  (two questions on the same stages, split {fmt(arch)})")
    prompt_b = chat_ids(tokenizer, PROMPT_B)
    solo_b = generate(Pipeline(weights, arch), "b", prompt_b, args.max_new, stop_ids)
    pipe = Pipeline(weights, arch)
    streams = {"a": generate_stream(pipe, "a", prompt_ids, args.max_new, stop_ids),
               "b": generate_stream(pipe, "b", prompt_b, args.max_new, stop_ids)}
    steps = {"a": [], "b": []}
    while streams:
        for sid in list(streams):
            try:
                steps[sid].append(next(streams[sid]))
            except StopIteration:
                del streams[sid]

    def same_run(run, expected):
        return [t for t, _ in run] == expected[0] and all(np.array_equal(r, e) for (_, r), e in zip(run, expected[1]))

    check("interleaved sessions match running each alone, bit for bit",
          same_run(steps["a"], (base_tokens, base_logits)) and same_run(steps["b"], solo_b))
    check("every stage holds one KV cache per session", all(sorted(s.sessions) == ["a", "b"] for s in pipe.stages))
    pipe.drop("a")
    rerun = generate(pipe, "a", prompt_ids, args.max_new, stop_ids)
    check("drop() frees a session, and a fresh run gives the same answer",
          rerun[0] == base_tokens and all("b" in s.sessions for s in pipe.stages))
    try:
        pipe.forward("b", [1], 0)
        rejected = False
    except ValueError:
        rejected = True
    check("a token at the wrong position is rejected", rejected)

    print("\n6. Test vectors for the JS engine")
    answer = tokenizer.decode(base_tokens, skip_special_tokens=True)
    size = write_testvectors(args.testvectors, weights, manifest, PROMPT, prompt_ids, base_tokens, answer, fmt(arch))
    rel_dir = args.testvectors.relative_to(ROOT) if args.testvectors.is_relative_to(ROOT) else args.testvectors
    print(f"  wrote {rel_dir}/  ({size / 1e6:.1f} MB)")

    passed = sum(results)
    print(f"\n{passed}/{len(results)} checks passed in {time.time() - t_start:.0f} s")
    sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()

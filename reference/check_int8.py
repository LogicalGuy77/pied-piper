"""Checks for the int8 export: how close is it to float32, and does splitting still change nothing?

int8 can't match Hugging Face token for token, so the ground truth here is
the float32 export, which check.py has already proved equal to Hugging Face.

1. The int8 files are intact, and every weight is within half a step of float32.
2. Quality: fed the float32 answers, int8 picks the same next token almost
   every time, and its next-token distribution stays close.
3. Every split gives bit-identical logits to the unsplit int8 run, and the
   prompt in one pass equals one token at a time.

Then writes testvectors-int8/ for the JS engine.

    .venv/bin/python reference/export.py --dtype int8
    .venv/bin/python reference/check_int8.py
"""

import argparse
import sys
import time
from pathlib import Path

import numpy as np
from transformers import AutoTokenizer

from check import PROMPT, chat_ids, check, files_intact, fmt, results, splits_for, write_testvectors
from export import DEFAULT_OUT, DEFAULT_OUT_INT8, ROOT
from pipeline import Pipeline, generate
from stage import load_manifest, read_file

QUALITY_PROMPTS = [
    PROMPT,
    "Write a haiku about phones.",
    "What is the capital of France? Answer in one word.",
    "List three uses of a paperclip.",
    "Translate 'good morning' into Spanish.",
]
MIN_AGREEMENT = 0.95  # measured: 194 of 198 next tokens
MAX_MEAN_KL = 0.01    # measured: 0.0036 nats


def entries(manifest):
    return [manifest["embed"], manifest["final_norm"], *manifest["layers"]] + (
        [manifest["lm_head"]] if manifest["lm_head"] else [])


def within_half_step(int8_dir, int8_manifest, f32_dir, f32_manifest):
    worst, count = 0.0, 0
    for e8, e32 in zip(entries(int8_manifest), entries(f32_manifest)):
        deq, ref = read_file(int8_dir, e8), read_file(f32_dir, e32)
        for t in e8["tensors"]:
            w, d = ref[t["name"]], deq[t["name"]]
            count += 1
            if t["dtype"] == "float32":
                if not np.array_equal(w, d):
                    return False, f"{e8['file']}:{t['name']} should be unchanged float32"
                continue
            step = np.abs(w).max(axis=1, keepdims=True) / 127
            ratio = float((np.abs(w - d) / step).max())
            worst = max(worst, ratio)
            if not ratio <= 0.5 + 1e-3:
                return False, f"{e8['file']}:{t['name']} is off by {ratio:.3f} steps"
    return True, f"{count} tensors, worst {worst:.3f} of a step"


def log_softmax(x):
    x = x.astype(np.float64)
    x = x - x.max(axis=-1, keepdims=True)
    return x - np.log(np.exp(x).sum(axis=-1, keepdims=True))


def main():
    ap = argparse.ArgumentParser(description="int8 export checks.")
    ap.add_argument("--weights", type=Path, default=DEFAULT_OUT_INT8)
    ap.add_argument("--float32", type=Path, default=DEFAULT_OUT, help="the float32 export to compare against")
    ap.add_argument("--max-new", type=int, default=40, help="tokens to generate per run")
    ap.add_argument("--testvectors", type=Path, default=ROOT / "testvectors-int8")
    args = ap.parse_args()
    t_start = time.time()

    weights = args.weights
    manifest = load_manifest(weights)
    f32_manifest = load_manifest(args.float32)
    if manifest.get("dtype") != "int8":
        raise SystemExit(f"{weights} is not an int8 export; run reference/export.py --dtype int8")
    L = manifest["config"]["num_layers"]
    eos = manifest["config"]["eos_token_id"]
    stop_ids = set(eos if isinstance(eos, list) else [eos])
    tokenizer = AutoTokenizer.from_pretrained(weights / "tokenizer")
    arch = splits_for(L)[1]

    print("\n1. Exported weights")
    check("files match the sha256 in manifest.json", *files_intact(weights, manifest))
    check("every weight within half a quantization step of float32, norms unchanged",
          *within_half_step(weights, manifest, args.float32, f32_manifest))
    size8 = sum(e["bytes"] for e in entries(manifest))
    size32 = sum(e["bytes"] for e in entries(f32_manifest))
    print(f"        {size8 / 1e6:.1f} MB instead of {size32 / 1e6:.1f} MB ({size8 / size32:.0%})")

    print(f"\n2. Quality vs float32  ({len(QUALITY_PROMPTS)} prompts, fed the float32 answers)")
    ref, q8 = Pipeline(args.float32, arch), Pipeline(weights, arch)
    agree = total = 0
    kls = []
    for i, text in enumerate(QUALITY_PROMPTS):
        ids = chat_ids(tokenizer, text)
        answer, _ = generate(ref, f"g{i}", ids, 60, stop_ids)
        teacher = ids + answer[:-1]
        a = log_softmax(ref.forward(f"r{i}", teacher, 0)[len(ids) - 1:])
        b = log_softmax(q8.forward(f"q{i}", teacher, 0)[len(ids) - 1:])
        agree += int((b.argmax(axis=-1) == np.array(answer)).sum())
        total += len(answer)
        kls.append(float((np.exp(a) * (a - b)).sum(axis=-1).mean()))
    check(f"same next token as float32 at least {MIN_AGREEMENT:.0%} of the time", agree / total >= MIN_AGREEMENT,
          f"{agree} of {total}")
    check(f"mean KL divergence from float32 below {MAX_MEAN_KL}", np.mean(kls) <= MAX_MEAN_KL,
          f"{np.mean(kls):.4f} nats")

    prompt_ids = chat_ids(tokenizer, PROMPT)
    base_tokens, base_logits = generate(Pipeline(weights, [0, L]), "s", prompt_ids, args.max_new, stop_ids)
    f32_tokens, _ = generate(Pipeline(args.float32, arch), "s", prompt_ids, args.max_new, stop_ids)
    print(f"        int8:    {tokenizer.decode(base_tokens, skip_special_tokens=True)!r}")
    print(f"        float32: {tokenizer.decode(f32_tokens, skip_special_tokens=True)!r}")

    print("\n3. Split into stages vs unsplit int8")
    for b in splits_for(L)[1:]:
        tokens, logits = generate(Pipeline(weights, b), "s", prompt_ids, args.max_new, stop_ids)
        same = tokens == base_tokens and all(np.array_equal(x, y) for x, y in zip(logits, base_logits))
        check(f"split {fmt(b)}: same tokens, bit-identical logits", same, f"{len(b) - 1} stages")
    tokens, _ = generate(Pipeline(weights, arch), "s", prompt_ids, args.max_new, stop_ids, prefill="one_by_one")
    check("prompt one token at a time: same tokens", tokens == base_tokens)

    print("\n4. Test vectors for the JS engine")
    answer = tokenizer.decode(base_tokens, skip_special_tokens=True)
    size = write_testvectors(args.testvectors, weights, manifest, PROMPT, prompt_ids, base_tokens, answer,
                             fmt(arch), source="reference/stage.py on the int8 export, by reference/check_int8.py")
    rel_dir = args.testvectors.relative_to(ROOT) if args.testvectors.is_relative_to(ROOT) else args.testvectors
    print(f"  wrote {rel_dir}/  ({size / 1e6:.1f} MB)")

    passed = sum(results)
    print(f"\n{passed}/{len(results)} checks passed in {time.time() - t_start:.0f} s")
    sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()

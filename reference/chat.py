"""Ask the model a question through a simulated swarm of stages.

    .venv/bin/python reference/chat.py "Why is the sky blue?"
    .venv/bin/python reference/chat.py "Write a haiku about phones" --split 0,10,20,30
"""

import argparse
import time
from pathlib import Path

from transformers import AutoTokenizer

from check import chat_ids
from export import DEFAULT_OUT
from pipeline import Pipeline, generate_stream
from stage import load_manifest


def main():
    ap = argparse.ArgumentParser(description="Generate an answer through a chain of stages.")
    ap.add_argument("prompt")
    ap.add_argument("--split", default="0,8,22,30", help="stage boundaries, e.g. 0,8,22,30")
    ap.add_argument("--max-new", type=int, default=120)
    ap.add_argument("--weights", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args()

    boundaries = [int(b) for b in args.split.split(",")]
    manifest = load_manifest(args.weights)
    eos = manifest["config"]["eos_token_id"]
    stop_ids = set(eos if isinstance(eos, list) else [eos])
    tokenizer = AutoTokenizer.from_pretrained(args.weights / "tokenizer")
    pipe = Pipeline(args.weights, boundaries)

    print("Route:")
    for i, stage in enumerate(pipe.stages, 1):
        print(f"  stage {i}  {stage.describe():<28} {stage.weight_bytes / 1e6:6.1f} MB")
    print()

    prompt_ids = chat_ids(tokenizer, args.prompt)
    tokens, shown = [], ""
    t0 = time.perf_counter()
    for token, _ in generate_stream(pipe, "chat", prompt_ids, args.max_new, stop_ids):
        tokens.append(token)
        text = tokenizer.decode(tokens, skip_special_tokens=True)
        print(text[len(shown):], end="", flush=True)
        shown = text
    elapsed = time.perf_counter() - t0
    print("\n")

    print(f"{len(tokens)} tokens in {elapsed:.2f} s on this laptop  (prompt: {len(prompt_ids)} tokens)")
    print("Compute per stage, whole answer:")
    for i, (stage, seconds) in enumerate(zip(pipe.stages, pipe.seconds), 1):
        print(f"  stage {i}  {stage.describe():<28} {seconds * 1000:7.0f} ms")
    hops = len(pipe.stages) - 1
    print(f"Sent between stages: {pipe.wire_bytes / 1e3:.0f} KB over {hops} hops "
          f"({manifest['config']['hidden_size'] * 4 / 1e3:.1f} KB per token per hop)")


if __name__ == "__main__":
    main()

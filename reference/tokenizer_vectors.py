"""Write tokenizer test vectors for the browser tokenizer (step 3).

Encodes a set of tricky strings and chats with the Hugging Face tokenizer and
saves the ids, so swarm/test/check.js can prove swarm/src/tokenizer.js gives
exactly the same ids.

    .venv/bin/python reference/tokenizer_vectors.py
"""

import argparse
import json
from pathlib import Path

from transformers import AutoTokenizer

ROOT = Path(__file__).resolve().parent.parent

STRINGS = [
    "",
    "Hello world",
    "Explain in two sentences why the sky is blue.",
    " leading space",
    "trailing space ",
    "two  spaces   three    four",
    "line one\nline two\n\nafter a blank line\n",
    "\ttab\tseparated\t",
    "  \n  indented after newline",
    "I'm sure you'll see they've done it, isn't it? We'd go.",
    "DON'T SHOUT, I'M HERE",
    "Numbers: 0 7 42 1234567890 3.14159 -12 1,000,000",
    "Price: $19.99 (50% off!) #1 @home a+b=c ~/path/to-file_name.txt",
    "café naïve résumé Zürich jalapeño",
    "你好，世界！今天天气很好。",
    "नमस्ते दुनिया",
    "Привет, мир",
    "emoji 👍 👍🏽 🇮🇳 👨‍👩‍👧 ❤️",
    "def f(x):\n    return x ** 2  # square\n",
    "<|im_start|>user\nhi<|im_end|>\n",
    "text with <|im_end|> inside and <|endoftext|> too",
    "<not_a_special> < |im_start| >",
    "https://ethglobal.com/events?id=42&lang=en",
    "a" * 50 + " " + "ab" * 30,
    "The quick brown fox jumps over the lazy dog. " * 4,
]

CHATS = [
    [{"role": "user", "content": "Explain in two sentences why the sky is blue."}],
    [{"role": "system", "content": "You are terse."}, {"role": "user", "content": "Hi!"}],
    [
        {"role": "user", "content": "What is 2+2?"},
        {"role": "assistant", "content": "4"},
        {"role": "user", "content": "And times 3?"},
    ],
]


def ids_of(enc):
    return list(enc if isinstance(enc, list) else enc["input_ids"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", default=ROOT / "weights" / "smollm2-135m-instruct", type=Path)
    ap.add_argument("--out", default=ROOT / "testvectors" / "tokenizer.json", type=Path)
    args = ap.parse_args()

    tok = AutoTokenizer.from_pretrained(args.weights / "tokenizer")
    strings = []
    for s in STRINGS:
        ids = tok(s, add_special_tokens=False)["input_ids"]
        strings.append({"text": s, "ids": ids, "decoded": tok.decode(ids)})
    chats = []
    for messages in CHATS:
        ids = ids_of(tok.apply_chat_template(messages, add_generation_prompt=True))
        text = tok.apply_chat_template(messages, add_generation_prompt=True, tokenize=False)
        chats.append({"messages": messages, "text": text, "ids": ids})

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({"source": "Hugging Face AutoTokenizer", "strings": strings, "chats": chats},
                                   ensure_ascii=False, indent=1))
    print(f"wrote {len(strings)} strings and {len(chats)} chats to {args.out}")


if __name__ == "__main__":
    main()

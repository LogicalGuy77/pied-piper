# Step 1: Python reference

A from-scratch NumPy version of SmolLM2-135M-Instruct that runs as a chain of
**stages**, each serving a range of layers. It is the ground truth for every
later step: the JS engine, the WASM kernels and the phones must reproduce its
outputs.

## Setup

```sh
python3 -m venv .venv
.venv/bin/pip install -r reference/requirements.txt
```

## Run

```sh
.venv/bin/python reference/export.py    # weights/smollm2-135m-instruct/ (538 MB)
.venv/bin/python reference/check.py     # 17 checks, writes testvectors/
.venv/bin/python reference/tokenizer_vectors.py   # tokenizer ids for step 3
.venv/bin/python reference/chat.py "Why is the sky blue?" --split 0,8,22,30
```

`check.py` exits non-zero if any check fails. A passing run ends with
`17/17 checks passed`.

## What the checks prove

| Check | Why it matters |
|---|---|
| Exported tensors equal Hugging Face's, bit for bit | The weight files phones download are right |
| Hidden state after every layer matches Hugging Face (relative error ~2e-6) | Our math is right, layer by layer |
| Greedy tokens identical to Hugging Face `generate()` | The answer is the real model's answer |
| Logits match at every decode step | The KV cache and positions are right (a RoPE position bug passes the prompt checks but fails here) |
| Every split gives **bit-identical** logits to the unsplit model, down to one layer per stage | Splitting across phones changes nothing |
| Prompt in one pass equals one token at a time | Batched prefill is safe |
| Interleaved sessions equal each session run alone | Many users can share the same phones |

## Files

| File | Role |
|---|---|
| `stage.py` | The stage contract and engine: `Stage(weights, start, end).forward(session_id, x, pos)` |
| `pipeline.py` | Simulated swarm: stages in a chain, with h sent between them as raw float32 bytes |
| `export.py` | Hugging Face model → `weights/<model>/` |
| `check.py` | The checks above, plus test vectors |
| `chat.py` | Ask a question through a chosen split and see per-stage compute |
| `tokenizer_vectors.py` | Hugging Face's ids for tricky strings and chats, so step 3's browser tokenizer can be checked |

## Weight format (`weights/<model>/`)

- `layer_00.bin` … `layer_29.bin`: 14.2 MB each, nine tensors back to back
- `embed.bin`: 113.2 MB embedding table, also used as the output layer
- `final_norm.bin`
- `manifest.json`: model config, plus every tensor's name, shape, byte offset, and each file's sha256
- `tokenizer/`

All files are raw little-endian float32. Linear weights are `[out, in]`
row-major, so `y = W @ x` is one dot product per row. RoPE follows Hugging
Face's convention: dimension `i` pairs with `i + head_dim/2`.

## Test vectors (`testvectors/`)

Step 2 loads these and must match them within `index.json → tolerance`:

- `prefill_hidden.bin`: `[31, 40, 576]`, the h at every layer boundary for the 40-token prompt
- `prefill_logits_last.bin`
- `decode_hidden.bin`, `decode_logits.bin`: 3 decode steps using the KV cache
- `index.json`: shapes, prompt ids, decode positions, expected greedy tokens
- `tokenizer.json` (from `tokenizer_vectors.py`): text → ids for step 3's tokenizer

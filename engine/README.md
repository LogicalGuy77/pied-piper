# Step 2: JS stage engine

The stage engine in plain JavaScript, with no dependencies. It runs unchanged
in Node and, in step 3, inside a browser Web Worker on each phone. It
implements the same contract as [`reference/stage.py`](../reference/stage.py)
and is checked against the Python reference's test vectors.

## Run

Needs Node 20+ and the outputs of step 1 (`weights/` and `testvectors/`):

```sh
.venv/bin/python reference/export.py   # if weights/ is missing
.venv/bin/python reference/check.py    # if testvectors/ is missing
cd engine && npm run check             # 15 checks, about 50 s
```

A passing run ends with `15/15 checks passed`.

## What the checks prove

| Check | Result on this laptop |
|---|---|
| h after the embedding and every layer matches Python, prompt pass | worst relative error 1.2e-6 |
| Same for 3 decode steps through the KV cache | worst relative error 6.8e-7 |
| Logits match | max abs diff 2.9e-5 |
| Greedy tokens through the 3-block split equal Python's and Hugging Face's | 40 of 40 |
| Every other split, down to one layer per stage, is **bit-identical** | yes |
| Prompt in one pass vs one token at a time is **bit-identical** | yes (NumPy only agreed to 4e-5) |
| Interleaved sessions equal each session run alone | yes |

Planted bugs that the checks catch: wrong query-to-KV head mapping, RoPE
pairing neighbouring dimensions (llama2.c's convention, not Hugging Face's),
and a KV cache that forgets earlier tokens.

## Files

| File | Role |
|---|---|
| `src/kernels.js` | The math: matmul, RMSNorm, RoPE, attention, SiLU. Step 4 swaps this file for WASM SIMD |
| `src/stage.js` | `Stage.load({ manifest, start, end, readFile })`, then `forward(sessionId, x, pos)` |
| `src/pipeline.js` | Stages in a chain, h passed as raw bytes; greedy `generate()` |
| `src/node-files.js` | Node-only: read weights and test vectors from disk |
| `test/check.js` | The checks |

## Using a stage

```js
import { openWeights } from "./src/node-files.js";
import { Stage } from "./src/stage.js";

const weights = await openWeights("../weights/smollm2-135m-instruct");
const first = await Stage.load({ ...weights, start: 0, end: 8 });
const second = await Stage.load({ ...weights, start: 8, end: 30 });

const h = first.forward("session-1", [1, 9690, 198], 0);              // Float32Array, 3 × 576
const logits = second.forward("session-1", h, 0, { lastOnly: true });  // Float32Array, 49152
```

In the browser, `readFile` becomes `(name) => fetch(url + name).then((r) => r.arrayBuffer())`.

## Differences from the Python reference

- Dot products accumulate in float64, which is JS's number type, and every
  stored value is float32. That's why results agree with NumPy to about 1e-6
  rather than bit for bit.
- The last stage can return logits for the last position only
  (`{ lastOnly: true }`). Generation only needs that one row, and it saves a
  49152 × 576 matmul for every other prompt token.
- `Math.exp`, `Math.cos` and `Math.sin` may differ in the last bit between
  browsers, so two phones on different browsers are not guaranteed
  bit-identical. The WASM kernels in step 4 fix that, which the planned
  hash-based verification needs.

## Speed

Plain JS on one thread: about 130 ms per token for the whole model on this
laptop, and about 4 s for a 40-token prompt. Phones will be several times
slower. Step 4 (WASM SIMD, int8 weights) is where speed gets fixed.

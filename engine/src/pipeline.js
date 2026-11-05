// Simulated swarm: a chain of stages in one process. Between stages h is
// copied into a fresh ArrayBuffer of raw float32 bytes, the same payload a
// WebSocket frame carries between phones in step 3.

import { Stage } from "./stage.js";

export class Pipeline {
  // boundaries like [0, 8, 22, 30] give stages [0, 8), [8, 22), [22, 30).
  static async load({ manifest, boundaries, readFile, kernels }) {
    const stages = [];
    for (let i = 0; i + 1 < boundaries.length; i++) {
      stages.push(await Stage.load({ manifest, start: boundaries[i], end: boundaries[i + 1], readFile, kernels }));
    }
    return new Pipeline(stages);
  }

  constructor(stages) {
    if (!stages[0].hasEmbedding || !stages.at(-1).hasOutput) {
      throw new Error("stages must start at layer 0 and end at the last layer");
    }
    this.stages = stages;
    this.ms = stages.map(() => 0); // compute time spent in each stage
    this.wireBytes = 0;            // bytes sent between stages
  }

  forward(sessionId, tokenIds, pos, { lastOnly = false } = {}) {
    let x = tokenIds;
    for (let i = 0; i < this.stages.length; i++) {
      const stage = this.stages[i];
      const t0 = performance.now();
      const out = stage.forward(sessionId, x, pos, { lastOnly });
      this.ms[i] += performance.now() - t0;
      if (stage.hasOutput) return out;
      const wire = new Uint8Array(out.buffer, out.byteOffset, out.byteLength).slice().buffer;
      this.wireBytes += wire.byteLength;
      x = new Float32Array(wire);
    }
  }

  drop(sessionId) {
    for (const stage of this.stages) stage.drop(sessionId);
  }
}

export function argmax(row) {
  let best = 0;
  for (let i = 1; i < row.length; i++) if (row[i] > row[best]) best = i;
  return best;
}

// Greedy decoding. Yields { token, logits } for each new token.
// prefill "batch" sends the whole prompt in one pass, "one_by_one" a token at a time.
export function* generateStream(pipe, sessionId, promptIds, maxNew, stopIds = new Set(), prefill = "batch") {
  let logits;
  if (prefill === "batch") {
    logits = pipe.forward(sessionId, promptIds, 0, { lastOnly: true });
  } else if (prefill === "one_by_one") {
    promptIds.forEach((token, i) => { logits = pipe.forward(sessionId, [token], i, { lastOnly: true }); });
  } else {
    throw new Error(`unknown prefill mode ${prefill}`);
  }
  let pos = promptIds.length;
  for (let i = 0; i < maxNew; i++) {
    const token = argmax(logits);
    yield { token, logits };
    if (stopIds.has(token) || i === maxNew - 1) return;
    logits = pipe.forward(sessionId, [token], pos, { lastOnly: true });
    pos += 1;
  }
}

export function generate(pipe, sessionId, promptIds, maxNew, stopIds = new Set(), prefill = "batch") {
  const steps = [...generateStream(pipe, sessionId, promptIds, maxNew, stopIds, prefill)];
  return { tokens: steps.map((s) => s.token), logits: steps.map((s) => s.logits) };
}

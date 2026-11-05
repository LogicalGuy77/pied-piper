// A stage runs a contiguous range of decoder layers. Same contract as
// reference/stage.py, and runs unchanged in Node and in a browser worker:
//
//   const stage = await Stage.load({ manifest, start, end, readFile })
//   const out = stage.forward(sessionId, x, pos)
//   const out = await stage.forwardAsync(sessionId, x, pos, {}, pause)
//   stage.drop(sessionId)
//
// forwardAsync gives the same result, but awaits pause() after every layer so
// the caller's event loop keeps running: a phone keeps reading its socket and
// answering heartbeats during a long prefill.
//
//   x    token ids (array or Int32Array of length n)   if stage.hasEmbedding
//        hidden state h, Float32Array of length n * d  otherwise
//   pos  position of x[0] in the session. Must equal the number of tokens
//        this stage has already seen for that session.
//   out  logits, Float32Array of length n * vocab      if stage.hasOutput
//        (only the last position with { lastOnly: true })
//        hidden state h, Float32Array of length n * d  otherwise
//
// readFile(name) returns the bytes of one weight file (ArrayBuffer or a
// typed-array view): fs in Node, fetch in the browser.

import { addInPlace, attention, copyRow, matmul, rmsNorm, rope, ropeInvFreq, siluMul } from "./kernels.js";

if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) {
  throw new Error("weights and h are little-endian float32; this platform is big-endian");
}

function byteView(bytes) {
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (bytes.byteOffset % 4 === 0) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return new Uint8Array(bytes); // unaligned view: copy
}

// Load one exported file and return { tensor name: Float32Array view }, or
// { q: Int8Array, scale: Float32Array } views for int8 tensors.
async function readTensors(readFile, entry) {
  const raw = byteView(await readFile(entry.file));
  if (raw.byteLength !== entry.bytes) {
    throw new Error(`${entry.file}: expected ${entry.bytes} bytes, got ${raw.byteLength}`);
  }
  const f32 = (offset, count) => new Float32Array(raw.buffer, raw.byteOffset + offset, count);
  const tensors = {};
  for (const t of entry.tensors) {
    const count = t.shape.reduce((a, b) => a * b, 1);
    tensors[t.name] = (t.dtype ?? "float32") === "int8"
      ? { q: new Int8Array(raw.buffer, raw.byteOffset + t.offset, count), scale: f32(t.scale_offset, t.shape[0]) }
      : f32(t.offset, count);
  }
  return tensors;
}

const bytesOf = (w) => (w instanceof Float32Array ? w.byteLength : w.q.byteLength + w.scale.byteLength);

// Per-session, per-layer KV cache: [tokens, kvHeads, headDim], grown by doubling.
class KVCache {
  constructor(rowSize) {
    this.rowSize = rowSize;
    this.length = 0;
    this.K = new Float32Array(rowSize * 64);
    this.V = new Float32Array(rowSize * 64);
  }

  append(k, v, n) {
    const needed = (this.length + n) * this.rowSize;
    if (needed > this.K.length) {
      let size = this.K.length;
      while (size < needed) size *= 2;
      const K = new Float32Array(size), V = new Float32Array(size);
      K.set(this.K.subarray(0, this.length * this.rowSize));
      V.set(this.V.subarray(0, this.length * this.rowSize));
      this.K = K;
      this.V = V;
    }
    this.K.set(k, this.length * this.rowSize);
    this.V.set(v, this.length * this.rowSize);
    this.length += n;
  }

  get bytes() {
    return this.length * this.rowSize * 4 * 2;
  }
}

export class Stage {
  static async load({ manifest, start, end, readFile }) {
    const L = manifest.config.num_layers;
    if (!(start >= 0 && start < end && end <= L)) {
      throw new Error(`layer range [${start}, ${end}) is outside 0..${L}`);
    }
    const layers = [];
    for (let i = start; i < end; i++) layers.push(await readTensors(readFile, manifest.layers[i]));
    const tied = manifest.lm_head === null;
    const hasEmbedding = start === 0;
    const hasOutput = end === L;
    let embed = null, finalNorm = null, lmHead = null;
    if (hasEmbedding || (hasOutput && tied)) embed = (await readTensors(readFile, manifest.embed)).embed_tokens;
    if (hasOutput) {
      finalNorm = (await readTensors(readFile, manifest.final_norm)).norm;
      lmHead = tied ? embed : (await readTensors(readFile, manifest.lm_head)).lm_head;
    }
    return new Stage(manifest.config, start, end, layers, embed, finalNorm, lmHead);
  }

  constructor(config, start, end, layers, embed, finalNorm, lmHead) {
    this.start = start;
    this.end = end;
    this.hasEmbedding = start === 0;
    this.hasOutput = end === config.num_layers;
    this.d = config.hidden_size;
    this.inter = config.intermediate_size;
    this.nHeads = config.num_heads;
    this.nKvHeads = config.num_kv_heads;
    this.headDim = config.head_dim;
    this.vocab = config.vocab_size;
    this.eps = config.rms_norm_eps;
    this.layers = layers;
    this.embed = embed;
    this.finalNorm = finalNorm;
    this.lmHead = lmHead;
    this.invFreq = ropeInvFreq(this.headDim, config.rope_theta);
    this.kv = new Map();   // session id -> one KVCache per layer
    this.seen = new Map(); // session id -> tokens processed so far
  }

  get sessions() {
    return [...this.seen.keys()];
  }

  get weightBytes() {
    const arrays = new Set(this.layers.flatMap((layer) => Object.values(layer)));
    for (const a of [this.embed, this.finalNorm, this.lmHead]) if (a) arrays.add(a);
    let total = 0;
    for (const a of arrays) total += bytesOf(a);
    return total;
  }

  kvBytes(sessionId) {
    return (this.kv.get(sessionId) ?? []).reduce((sum, c) => sum + c.bytes, 0);
  }

  describe() {
    const parts = this.hasEmbedding ? ["embedding"] : [];
    const last = this.end - 1;
    parts.push(last > this.start ? `layers ${this.start}–${last}` : `layer ${this.start}`);
    if (this.hasOutput) parts.push("output");
    return parts.join(" + ");
  }

  drop(sessionId) {
    this.kv.delete(sessionId);
    this.seen.delete(sessionId);
  }

  // If `trace` is an array, h after the embedding (first stage only) and
  // after every layer is pushed onto it. Used by the test vectors.
  forward(sessionId, x, pos, opts = {}) {
    const run = this.steps(sessionId, x, pos, opts);
    let r;
    while (!(r = run.next()).done);
    return r.value;
  }

  async forwardAsync(sessionId, x, pos, opts = {}, pause = () => Promise.resolve()) {
    const run = this.steps(sessionId, x, pos, opts);
    let r;
    while (!(r = run.next()).done) await pause();
    return r.value;
  }

  // The forward pass, yielding after every layer.
  *steps(sessionId, x, pos, { trace = null, lastOnly = false } = {}) {
    const seen = this.seen.get(sessionId) ?? 0;
    if (pos !== seen) {
      throw new Error(`session ${JSON.stringify(sessionId)}: this stage has seen ${seen} tokens, got pos ${pos}`);
    }
    const d = this.d;
    let h, n;
    if (this.hasEmbedding) {
      n = x.length;
      h = new Float32Array(n * d);
      for (let t = 0; t < n; t++) {
        const id = x[t];
        if (!(id >= 0 && id < this.vocab)) throw new Error(`token id ${id} is outside 0..${this.vocab - 1}`);
        copyRow(this.embed, id, d, h, t * d);
      }
      if (trace) trace.push(h);
    } else {
      if (!(x instanceof Float32Array) || x.length === 0 || x.length % d !== 0) {
        throw new Error(`expected a Float32Array of n * ${d} values`);
      }
      h = x;
      n = x.length / d;
    }

    if (!this.kv.has(sessionId)) {
      this.kv.set(sessionId, this.layers.map(() => new KVCache(this.nKvHeads * this.headDim)));
    }
    const caches = this.kv.get(sessionId);
    for (let i = 0; i < this.layers.length; i++) {
      h = this.layer(this.layers[i], caches[i], h, n, pos);
      if (trace) trace.push(h);
      yield;
    }
    this.seen.set(sessionId, pos + n);

    if (!this.hasOutput) return h;
    const rows = lastOnly ? 1 : n;
    const last = lastOnly ? h.subarray((n - 1) * d) : h;
    return matmul(rmsNorm(last, this.finalNorm, rows, d, this.eps), this.lmHead, rows, d, this.vocab);
  }

  layer(w, cache, h, n, pos) {
    const { d, inter, nHeads: H, nKvHeads: KVH, headDim: hd, eps } = this;

    // Attention
    let x = rmsNorm(h, w.input_layernorm, n, d, eps);
    const q = matmul(x, w.q_proj, n, d, H * hd);
    const k = matmul(x, w.k_proj, n, d, KVH * hd);
    const v = matmul(x, w.v_proj, n, d, KVH * hd);
    rope(q, n, H, hd, pos, this.invFreq);
    rope(k, n, KVH, hd, pos, this.invFreq);
    cache.append(k, v, n);
    const att = attention(q, cache.K, cache.V, n, pos, cache.length, H, KVH, hd);
    const h1 = matmul(att, w.o_proj, n, H * hd, d);
    addInPlace(h1, h);

    // MLP
    x = rmsNorm(h1, w.post_attention_layernorm, n, d, eps);
    const gate = matmul(x, w.gate_proj, n, d, inter);
    siluMul(gate, matmul(x, w.up_proj, n, d, inter));
    const h2 = matmul(gate, w.down_proj, n, inter, d);
    addInPlace(h2, h1);
    return h2;
  }
}

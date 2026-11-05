// Math kernels for one transformer layer, in plain JS on Float32Array.
// The matmuls, nearly all of the compute, also run in WASM SIMD (wasm.js)
// when a stage's matrices live in a wasm arena.
//
// Layout everywhere: row-major. A batch of n vectors of width d is one
// Float32Array of length n * d, vector t at offset t * d.

// A weight matrix is a Float32Array, { q: Int8Array, scale: Float32Array }
// for int8 with one scale per row (W[o][i] = q[o * in + i] * scale[o]), or a
// handle into a wasm arena ({ arena, ... }, from WasmArena.matrix).

// y[n, out] = x[n, in] @ W[out, in]^T, one dot product per (token, row).
// Rows of W are the outer loop so each row stays in cache across the n tokens.
export function matmul(x, W, n, inDim, outDim) {
  if (W.arena) return W.arena.matmul(x, W, n, inDim, outDim);
  if (!(W instanceof Float32Array)) return matmulInt8(x, W.q, W.scale, n, inDim, outDim);
  const y = new Float32Array(n * outDim);
  for (let o = 0; o < outDim; o++) {
    const w0 = o * inDim;
    for (let t = 0; t < n; t++) {
      const x0 = t * inDim;
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      let i = 0;
      for (; i + 3 < inDim; i += 4) {
        s0 += W[w0 + i] * x[x0 + i];
        s1 += W[w0 + i + 1] * x[x0 + i + 1];
        s2 += W[w0 + i + 2] * x[x0 + i + 2];
        s3 += W[w0 + i + 3] * x[x0 + i + 3];
      }
      for (; i < inDim; i++) s0 += W[w0 + i] * x[x0 + i];
      y[t * outDim + o] = s0 + s1 + s2 + s3;
    }
  }
  return y;
}

// Same loop on int8 rows; the row's scale is applied once to the dot product.
function matmulInt8(x, q, scale, n, inDim, outDim) {
  const y = new Float32Array(n * outDim);
  for (let o = 0; o < outDim; o++) {
    const w0 = o * inDim;
    const s = scale[o];
    for (let t = 0; t < n; t++) {
      const x0 = t * inDim;
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      let i = 0;
      for (; i + 3 < inDim; i += 4) {
        s0 += q[w0 + i] * x[x0 + i];
        s1 += q[w0 + i + 1] * x[x0 + i + 1];
        s2 += q[w0 + i + 2] * x[x0 + i + 2];
        s3 += q[w0 + i + 3] * x[x0 + i + 3];
      }
      for (; i < inDim; i++) s0 += q[w0 + i] * x[x0 + i];
      y[t * outDim + o] = (s0 + s1 + s2 + s3) * s;
    }
  }
  return y;
}

// Row r of a weight matrix as float32 values, written into out at offset.
export function copyRow(W, r, d, out, offset) {
  if (W.arena) return W.arena.copyRow(W, r, out, offset);
  if (W instanceof Float32Array) return out.set(W.subarray(r * d, (r + 1) * d), offset);
  const s = W.scale[r];
  for (let i = 0; i < d; i++) out[offset + i] = W.q[r * d + i] * s;
}

export function rmsNorm(x, weight, n, d, eps) {
  const y = new Float32Array(n * d);
  for (let t = 0; t < n; t++) {
    const x0 = t * d;
    let ss = 0;
    for (let i = 0; i < d; i++) ss += x[x0 + i] * x[x0 + i];
    const inv = 1 / Math.sqrt(ss / d + eps);
    for (let i = 0; i < d; i++) y[x0 + i] = x[x0 + i] * inv * weight[i];
  }
  return y;
}

// Inverse RoPE frequencies, computed in float32 like Hugging Face does.
export function ropeInvFreq(headDim, theta) {
  const inv = new Float32Array(headDim / 2);
  for (let i = 0; i < headDim; i += 2) {
    inv[i / 2] = 1 / Math.fround(Math.pow(theta, Math.fround(i / headDim)));
  }
  return inv;
}

// Rotates x[n, heads, headDim] in place. Hugging Face convention: dimension i
// pairs with i + headDim/2 (rotate_half), not with i + 1.
export function rope(x, n, heads, headDim, pos, invFreq) {
  const half = headDim / 2;
  for (let t = 0; t < n; t++) {
    for (let i = 0; i < half; i++) {
      const angle = Math.fround((pos + t) * invFreq[i]);
      const c = Math.cos(angle), s = Math.sin(angle);
      for (let h = 0; h < heads; h++) {
        const b = (t * heads + h) * headDim;
        const x1 = x[b + i], x2 = x[b + i + half];
        x[b + i] = x1 * c - x2 * s;
        x[b + i + half] = x2 * c + x1 * s;
      }
    }
  }
}

// Causal attention for n new queries at positions pos..pos+n-1 against a KV
// cache holding `total` tokens ([total, kvHeads, headDim] each).
// Query head h reads KV head floor(h / (heads / kvHeads)).
export function attention(q, K, V, n, pos, total, heads, kvHeads, headDim) {
  if (pos + n !== total) throw new Error(`KV cache holds ${total} tokens, expected ${pos + n}`);
  const out = new Float32Array(n * heads * headDim);
  const group = heads / kvHeads;
  const scale = 1 / Math.sqrt(headDim);
  const scores = new Float64Array(total);
  for (let t = 0; t < n; t++) {
    const visible = pos + t + 1; // keys 0..pos+t
    for (let h = 0; h < heads; h++) {
      const kvh = Math.floor(h / group);
      const q0 = (t * heads + h) * headDim;
      let max = -Infinity;
      for (let j = 0; j < visible; j++) {
        const k0 = (j * kvHeads + kvh) * headDim;
        let dot = 0;
        for (let i = 0; i < headDim; i++) dot += q[q0 + i] * K[k0 + i];
        scores[j] = dot * scale;
        if (scores[j] > max) max = scores[j];
      }
      let sum = 0;
      for (let j = 0; j < visible; j++) {
        scores[j] = Math.exp(scores[j] - max);
        sum += scores[j];
      }
      for (let i = 0; i < headDim; i++) {
        let acc = 0;
        for (let j = 0; j < visible; j++) acc += scores[j] * V[(j * kvHeads + kvh) * headDim + i];
        out[q0 + i] = acc / sum;
      }
    }
  }
  return out;
}

// gate <- silu(gate) * up, in place.
export function siluMul(gate, up) {
  for (let i = 0; i < gate.length; i++) {
    const g = gate[i];
    gate[i] = (g / (1 + Math.exp(-g))) * up[i];
  }
}

// a <- a + b, in place.
export function addInPlace(a, b) {
  for (let i = 0; i < a.length; i++) a[i] += b[i];
}

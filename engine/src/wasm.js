// Runs the matmuls of one stage in WebAssembly SIMD (kernels.wat).
//
// Each stage gets its own wasm memory, an arena: its weight matrices are
// copied in once at load, and the space above them is scratch for each
// call's x and y. A stage that is dropped takes its arena with it, which a
// single shared memory could never give back.
//
//   const arena = await WasmArena.create(bytes)   // null if no wasm SIMD here
//   const W = arena.matrix(floatsOrInt8, rows, cols)
//   arena.matmul(x, W, n, inDim, outDim)           // same result layout as kernels.js

import { KERNELS_WASM } from "./kernels-wasm.js";

const PAGE = 65536;
// Not (n + 15) & ~15: JS bitwise ops are signed 32-bit, and an arena holding
// more than 2 GB (a whole 2B model in one stage) has offsets past that.
const align16 = (n) => Math.ceil(n / 16) * 16;

let compiled = null;
function kernelModule() {
  compiled ??= (async () => {
    if (typeof WebAssembly === "undefined") return null;
    const bytes = Uint8Array.from(atob(KERNELS_WASM), (c) => c.charCodeAt(0));
    if (!WebAssembly.validate(bytes)) return null; // this engine has no SIMD
    return WebAssembly.compile(bytes);
  })();
  return compiled;
}

export async function wasmAvailable() {
  return (await kernelModule()) !== null;
}

export class WasmArena {
  static async create(bytes) {
    const mod = await kernelModule();
    return mod ? new WasmArena(mod, bytes) : null;
  }

  constructor(mod, bytes) {
    this.memory = new WebAssembly.Memory({ initial: Math.ceil((bytes + PAGE) / PAGE) + 16 });
    this.k = new WebAssembly.Instance(mod, { env: { memory: this.memory } }).exports;
    this.top = 16; // first free byte; everything above is scratch
  }

  get bytes() {
    return this.memory.buffer.byteLength;
  }

  alloc(bytes) {
    const ptr = align16(this.top);
    this.top = ptr + bytes;
    this.ensure(this.top);
    return ptr;
  }

  ensure(end) {
    const short = end - this.memory.buffer.byteLength;
    if (short > 0) this.memory.grow(Math.ceil(short / PAGE));
  }

  // Copies a weight matrix in: a Float32Array, or { q: Int8Array, scale } for
  // int8. Returns a handle that matmul() and copyRow() in kernels.js route
  // here, or W unchanged if the kernels can't take its width.
  matrix(W, rows, cols) {
    if (cols % 16 !== 0) return W;
    if (W instanceof Float32Array) {
      const ptr = this.alloc(W.byteLength);
      new Float32Array(this.memory.buffer, ptr, W.length).set(W);
      return { arena: this, dtype: "f32", ptr, rows, cols, byteLength: W.byteLength };
    }
    const ptr = this.alloc(W.q.byteLength);
    new Int8Array(this.memory.buffer, ptr, W.q.length).set(W.q);
    const scalePtr = this.alloc(W.scale.byteLength);
    new Float32Array(this.memory.buffer, scalePtr, W.scale.length).set(W.scale);
    return { arena: this, dtype: "i8", ptr, scalePtr, rows, cols, byteLength: W.q.byteLength + W.scale.byteLength };
  }

  matmul(x, W, n, inDim, outDim) {
    const xp = align16(this.top);
    const yp = align16(xp + n * inDim * 4);
    this.ensure(yp + n * outDim * 4);
    new Float32Array(this.memory.buffer, xp, n * inDim).set(x.subarray(0, n * inDim));
    if (W.dtype === "f32") this.k.matmul_f32(xp, W.ptr, yp, n, inDim, outDim);
    else this.k.matmul_i8(xp, W.ptr, W.scalePtr, yp, n, inDim, outDim);
    return new Float32Array(this.memory.buffer, yp, n * outDim).slice();
  }

  // Row r of W as float32, written into out at offset (the embedding lookup).
  copyRow(W, r, out, offset) {
    const d = W.cols;
    if (W.dtype === "f32") {
      out.set(new Float32Array(this.memory.buffer, W.ptr + r * d * 4, d), offset);
      return;
    }
    const q = new Int8Array(this.memory.buffer, W.ptr + r * d, d);
    const s = new Float32Array(this.memory.buffer, W.scalePtr + r * 4, 1)[0];
    for (let i = 0; i < d; i++) out[offset + i] = q[i] * s;
  }
}

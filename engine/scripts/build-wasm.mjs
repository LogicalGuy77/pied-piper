// Compiles src/kernels.wat into src/kernels-wasm.js, the wasm bytes as
// base64, so the engine loads them with a plain import in Node and in the
// browser and needs no build step or extra file at runtime.
//
//   cd engine && npm run build:wasm

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import initWabt from "wabt";

const src = fileURLToPath(new URL("../src/kernels.wat", import.meta.url));
const out = fileURLToPath(new URL("../src/kernels-wasm.js", import.meta.url));

const wabt = await initWabt();
const mod = wabt.parseWat("kernels.wat", readFileSync(src, "utf8"), { simd: true });
mod.validate();
const { buffer } = mod.toBinary({});
mod.destroy();

const base64 = Buffer.from(buffer).toString("base64");
writeFileSync(out, `// Generated from kernels.wat by scripts/build-wasm.mjs. Do not edit.\n` +
  `export const KERNELS_WASM = "${base64}";\n`);
console.log(`wrote src/kernels-wasm.js (${buffer.length} bytes of wasm)`);

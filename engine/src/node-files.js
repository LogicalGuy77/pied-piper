// Node-only helpers: read a weights directory and the test vectors from disk.
// The browser version (step 3) does the same with fetch().

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function openWeights(dir) {
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  return { manifest, readFile: (name) => readFile(join(dir, name)) };
}

export async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

// Returns { index, arrays: { file name: Float32Array } }.
export async function openTestVectors(dir) {
  const index = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
  const arrays = {};
  for (const f of index.files) {
    const bytes = await readFile(join(dir, f.file));
    arrays[f.file] = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }
  return { index, arrays };
}

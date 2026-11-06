// Compiles the contracts in swarm/chain with the solc from npm, the version
// Uniswap v4 is built with (0.8.26, via IR, cancun). Imports resolve from
// node_modules (OpenZeppelin, @uniswap/v4-core, solmate). Output is cached in
// chain/out/, keyed by a hash of the input.
//
// compile() -> { Name: { abi, bytecode } } for swarm/chain/*.sol.
// compileV4Core() -> the same for v4's PoolManager, with v4-core's own
// settings, for a local test chain (Sepolia already has one).

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export function compile() {
  const sources = {};
  for (const name of readdirSync(HERE).filter((f) => f.endsWith(".sol"))) {
    sources[name] = { content: readFileSync(join(HERE, name), "utf8") };
  }
  return run(sources, 800);
}

export function compileV4Core() {
  const path = "@uniswap/v4-core/src/PoolManager.sol";
  return run({ [path]: { content: readFileSync(require.resolve(path), "utf8") } }, 44444444);
}

function run(sources, runs) {
  const solc = require("solc-0.8.26");
  const input = {
    language: "Solidity",
    sources,
    settings: {
      viaIR: true,
      optimizer: { enabled: true, runs },
      evmVersion: "cancun",
      metadata: { bytecodeHash: "none" },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const key = createHash("sha256").update(solc.version()).update(JSON.stringify(input)).digest("hex").slice(0, 16);
  const cache = join(HERE, "out", `${key}.json`);
  try {
    return JSON.parse(readFileSync(cache, "utf8"));
  } catch {}

  const findImports = (path) => {
    try {
      return { contents: readFileSync(require.resolve(path), "utf8") };
    } catch {
      return { error: `not found: ${path}` };
    }
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  const errors = (out.errors ?? []).filter((e) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
  const contracts = {};
  for (const file of Object.values(out.contracts)) {
    for (const [name, c] of Object.entries(file)) {
      if (c.evm.bytecode.object) contracts[name] = { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` };
    }
  }
  mkdirSync(dirname(cache), { recursive: true });
  writeFileSync(cache, JSON.stringify(contracts));
  return contracts;
}

// Compiles PiedPiperToken.sol and deploys it, minting the whole supply to the
// treasury: the wallet of TREASURY_PRIVATE_KEY in swarm/.env, which also pays
// the gas. Writes the token's address to chain/deployment.json, where the
// tracker finds it.
//
//   node swarm/chain/deploy.js [--supply 1000000] [--rpc URL] [--force]
//
// The chain is Unichain Sepolia; --rpc points at another node of it (or at a
// local test chain, for tests). --force deploys again over an existing
// deployment.json.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createPublicClient, createWalletClient, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { unichainSepolia } from "viem/chains";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEPLOYMENT = join(HERE, "deployment.json");

// { abi, bytecode } of PiedPiperToken, compiled with the solc from npm.
export function compile() {
  const require = createRequire(import.meta.url);
  const solc = require("solc");
  const input = {
    language: "Solidity",
    sources: { "PiedPiperToken.sol": { content: readFileSync(join(HERE, "PiedPiperToken.sol"), "utf8") } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
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
  const c = out.contracts["PiedPiperToken.sol"].PiedPiperToken;
  return { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` };
}

export async function deploy({ privateKey, rpcUrl, supply, chain = unichainSepolia }) {
  const { abi, bytecode } = compile();
  const account = privateKeyToAccount(privateKey);
  const transport = http(rpcUrl);
  const pub = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ account, chain, transport });
  const hash = await wallet.deployContract({ abi, bytecode, args: [account.address, parseUnits(String(supply), 6)] });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`deploy transaction ${hash} reverted`);
  return { chainId: chain.id, token: receipt.contractAddress, treasury: account.address, txHash: hash, block: Number(receipt.blockNumber), supply: String(supply) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values: opts } = parseArgs({
    options: { supply: { type: "string", default: "1000000" }, rpc: { type: "string" }, force: { type: "boolean", default: false } },
  });
  try {
    process.loadEnvFile(join(HERE, "..", ".env"));
  } catch {}
  const privateKey = process.env.TREASURY_PRIVATE_KEY?.trim();
  if (!privateKey) {
    console.error("Set TREASURY_PRIVATE_KEY in swarm/.env: a Unichain Sepolia wallet with a little ETH for gas.");
    process.exit(1);
  }
  if (existsSync(DEPLOYMENT) && !opts.force) {
    console.error(`Already deployed: ${readFileSync(DEPLOYMENT, "utf8").trim()}\nPass --force to deploy a new token.`);
    process.exit(1);
  }
  const rpcUrl = opts.rpc || process.env.CHAIN_RPC_URL?.trim() || unichainSepolia.rpcUrls.default.http[0];
  const d = await deploy({ privateKey, rpcUrl, supply: opts.supply });
  writeFileSync(DEPLOYMENT, JSON.stringify(d, null, 2) + "\n");
  const explorer = unichainSepolia.blockExplorers.default.url;
  console.log(`PIPER USDC (pUSDC) deployed at ${d.token}, ${d.supply} minted to the treasury ${d.treasury}`);
  console.log(`  ${explorer}/address/${d.token}`);
  console.log(`  written to ${DEPLOYMENT}`);
}

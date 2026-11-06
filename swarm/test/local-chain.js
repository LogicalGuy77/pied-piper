// Everything chain/deploy.js deploys, on a local test chain: first a v4
// PoolManager of its own (Sepolia already has one), then the rest.
// The chain must be Sepolia's id, 11155111, with Hardhat's funded
// accounts: account 0 is the treasury, account 1 the gas sponsor.

import { createPublicClient, createWalletClient, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN } from "../src/chain.js";
import { compileV4Core } from "../chain/compile.js";
import { deploy } from "../chain/deploy.js";

export const TREASURY_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const SPONSOR_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

export async function deployLocal(rpcUrl, options = {}) {
  const transport = http(rpcUrl);
  const pub = createPublicClient({ chain: CHAIN, transport });
  const treasury = createWalletClient({ account: privateKeyToAccount(TREASURY_KEY), chain: CHAIN, transport });
  const { PoolManager } = compileV4Core();
  const hash = await treasury.deployContract({ abi: PoolManager.abi, bytecode: PoolManager.bytecode, args: [treasury.account.address] });
  const { contractAddress } = await pub.waitForTransactionReceipt({ hash });
  return deploy({
    treasuryKey: TREASURY_KEY,
    sponsor: privateKeyToAccount(SPONSOR_KEY).address,
    rpcUrl,
    poolManager: getAddress(contractAddress),
    sponsorEth: "0",
    log: () => {},
    ...options,
  });
}

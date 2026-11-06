// Deploys the swarm's contracts on Sepolia and opens the PIPER/USDC
// Uniswap v4 pool, from the treasury (TREASURY_PRIVATE_KEY in swarm/.env),
// which pays the gas and ends up owning everything:
//
//   1. PIPER (PiedPiperToken.sol), the whole supply to the treasury;
//   2. USDC: Circle's Sepolia USDC, which the treasury must hold --seed-usdc
//      of (faucet.circle.com); or with --test-usdc, TestUSDC.sol, minted;
//   3. InferenceMarket.sol: askers' escrow, settled by the gas sponsor;
//   4. GasSponsorHook.sol, at a CREATE2 address mined for its v4 flags;
//   5. PiperRouter.sol, for the pool;
//   6. the pool: PIPER/USDC, --lp-fee, the hook; opened at --price USDC per
//      PIPER, with a full-range position of --seed-usdc USDC and the PIPER
//      to match;
//   7. --sponsor-eth ETH from the treasury to the gas sponsor
//      (SPONSOR_PRIVATE_KEY).
//
// Missing keys are made and written to swarm/.env first. Writes the
// addresses to chain/deployment.json, where the tracker finds them.
//
//   node swarm/chain/deploy.js [--price 0.01] [--token-price 0.2] [--seed-usdc 10]
//        [--test-usdc] [--sponsor-eth 0.02] [--rpc URL] [--force]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  concatHex, createPublicClient, createWalletClient, encodeAbiParameters, formatEther, getAddress, getContractAddress,
  http, keccak256, maxUint256, numberToHex, parseAbi, parseEther, parseUnits,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CHAIN, POOL_MANAGER, USDC } from "../src/chain.js";
import { compile } from "./compile.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV = join(HERE, "..", ".env");
export const DEPLOYMENT = join(HERE, "deployment.json");

export const POOL_MANAGER_ABI = parseAbi([
  "function initialize((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, uint160 sqrtPriceX96) returns (int24 tick)",
  "function extsload(bytes32 slot) view returns (bytes32)",
]);

const HOOK_FLAG_MASK = (1n << 14n) - 1n;
// GasSponsorHook.FLAGS: afterAddLiquidity, afterSwap, and both of their return deltas.
const HOOK_FLAGS = (1n << 10n) | (1n << 6n) | (1n << 2n) | (1n << 1n);
const Q96 = 1n << 96n;

// Defaults: PIPER opens at 0.01 USDC, an answer token costs 0.2 PIPER until
// the tracker sets the price from its model.
export async function deploy({
  treasuryKey, sponsor, rpcUrl, chain = CHAIN, poolManager = POOL_MANAGER, usdc = null,
  supply = "100000000", price = "0.01", tokenPrice = "0.2", seedPiper = "1000000", lpFee = 3000, tickSpacing = 60,
  sponsorEth = "0.02", log = console.log,
}) {
  const c = compile();
  const account = privateKeyToAccount(treasuryKey);
  const transport = http(rpcUrl);
  const pub = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ account, chain, transport });
  const treasury = account.address;

  const send = async (what, hash) => {
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${what}: transaction ${hash} reverted`);
    log(`  ${what}: tx ${hash}`);
    return receipt;
  };
  const create = async (name, args = []) => {
    const hash = await wallet.deployContract({ abi: c[name].abi, bytecode: c[name].bytecode, args });
    const { contractAddress } = await send(`${name} deployed`, hash);
    return getAddress(contractAddress);
  };
  const write = (what, address, abi, functionName, args, value) =>
    wallet.writeContract({ address, abi, functionName, args, value }).then((hash) => send(what, hash));

  const piper = await create("PiedPiperToken", [treasury, parseUnits(supply, 18)]);
  const seedPiperUnits = parseUnits(seedPiper, 18);
  const seedUsdcUnits = parseUnits((Number(seedPiper) * Number(price)).toFixed(6), 6);
  const testUsdc = !usdc;
  if (testUsdc) {
    usdc = await create("TestUSDC");
    // A deposit pays the hook's cut on top, so mint a little more than the pool takes.
    const want = (seedUsdcUnits * 1005n) / 1000n;
    const limit = 10_000n * 10n ** 6n;
    for (let minted = 0n; minted < want; minted += limit) {
      const amount = want - minted < limit ? want - minted : limit;
      await write(`minted ${Number(amount) / 1e6} USDC to the treasury`, usdc, c.TestUSDC.abi, "mint", [treasury, amount]);
    }
  }
  usdc = getAddress(usdc);

  const market = await create("InferenceMarket", [piper, treasury, sponsor, parseUnits(tokenPrice, 18)]);

  // The hook's address must carry its flags in its low 14 bits.
  const factory = await create("Create2Factory");
  const hookCode = concatHex([
    c.GasSponsorHook.bytecode,
    encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], [poolManager, sponsor, treasury]),
  ]);
  const { salt, address: hook } = mineSalt(factory, hookCode, HOOK_FLAGS);
  await write(`GasSponsorHook deployed at ${hook}`, factory, c.Create2Factory.abi, "deploy", [salt, hookCode]);

  const [currency0, currency1] = BigInt(piper) < BigInt(usdc) ? [piper, usdc] : [usdc, piper];
  const key = { currency0, currency1, fee: lpFee, tickSpacing, hooks: hook };
  const router = await create("PiperRouter", [poolManager, key, treasury]);

  // price is USDC per PIPER; the pool's is currency1 base units per currency0 base unit.
  const usdcPerPiper = parseUnits(price, 6); // USDC units per 1e18 PIPER units
  const sqrtPriceX96 = currency0 === piper
    ? sqrt((usdcPerPiper << 192n) / 10n ** 18n)
    : sqrt((10n ** 18n << 192n) / usdcPerPiper);
  await write(`pool opened at ${price} USDC per PIPER`, poolManager, POOL_MANAGER_ABI, "initialize", [key, sqrtPriceX96]);

  const ERC20 = parseAbi(["function approve(address, uint256) returns (bool)"]);
  await write("router may take the treasury's PIPER", piper, ERC20, "approve", [router, maxUint256]);
  await write("router may take the treasury's USDC", usdc, ERC20, "approve", [router, maxUint256]);
  // Full range, so a0 = L * Q96 / sqrtP and a1 = L * sqrtP / Q96 at most.
  const [a0, a1] = currency0 === piper ? [seedPiperUnits, seedUsdcUnits] : [seedUsdcUnits, seedPiperUnits];
  const l0 = (a0 * sqrtPriceX96) / Q96, l1 = (a1 * Q96) / sqrtPriceX96;
  const liquidity = ((l0 < l1 ? l0 : l1) * 99n) / 100n;
  await write(`seeded the pool with ${seedPiper} PIPER and ${Number(seedUsdcUnits) / 1e6} USDC`, router, c.PiperRouter.abi, "modifyLiquidity", [liquidity]);
  for (const [name, token] of [["PIPER", piper], ["USDC", usdc]]) {
    await write(`the deposit's ${name} cut sent to the gas sponsor`, hook, c.GasSponsorHook.abi, "collect", [token]);
  }

  if (Number(sponsorEth) > 0) {
    const hash = await wallet.sendTransaction({ to: sponsor, value: parseEther(sponsorEth) });
    await send(`sent ${sponsorEth} ETH to the gas sponsor ${sponsor}`, hash);
  }

  return {
    chainId: chain.id,
    treasury,
    sponsor,
    piper,
    usdc,
    testUsdc,
    market,
    poolManager: getAddress(poolManager),
    hook,
    router,
    pool: { ...key, price, sqrtPriceX96: String(sqrtPriceX96), liquidity: String(liquidity) },
    tokenPrice,
    block: Number(await pub.getBlockNumber()),
  };
}

// A CREATE2 salt that puts initCode at an address whose low 14 bits are flags.
export function mineSalt(factory, initCode, flags) {
  const codeHash = keccak256(initCode);
  for (let i = 0n; ; i++) {
    const salt = numberToHex(i, { size: 32 });
    const address = getContractAddress({ opcode: "CREATE2", from: factory, salt, bytecodeHash: codeHash });
    if ((BigInt(address) & HOOK_FLAG_MASK) === flags) return { salt, address };
  }
}

function sqrt(n) {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) {
      while (x * x > n) x--;
      while ((x + 1n) * (x + 1n) <= n) x++;
      return x;
    }
    x = y;
  }
}

// Writes KEY=value into swarm/.env, replacing an empty KEY= line if there is one.
function setEnv(key, value) {
  let text = existsSync(ENV) ? readFileSync(ENV, "utf8") : "";
  const line = new RegExp(`^${key}=.*$`, "m");
  text = line.test(text) ? text.replace(line, `${key}=${value}`) : `${text.replace(/\n?$/, "\n")}${key}=${value}\n`;
  writeFileSync(ENV, text);
  process.env[key] = value;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values: opts } = parseArgs({
    options: {
      price: { type: "string", default: "0.01" },
      "token-price": { type: "string", default: "0.2" },
      "seed-usdc": { type: "string", default: "10" },
      "sponsor-eth": { type: "string", default: "0.02" },
      "test-usdc": { type: "boolean", default: false },
      rpc: { type: "string" },
      force: { type: "boolean", default: false },
    },
  });
  try {
    process.loadEnvFile(ENV);
  } catch {}
  if (existsSync(DEPLOYMENT) && !opts.force) {
    console.error(`Already deployed: see ${DEPLOYMENT}\nPass --force to deploy everything again.`);
    process.exit(1);
  }
  for (const key of ["TREASURY_PRIVATE_KEY", "SPONSOR_PRIVATE_KEY"]) {
    if (!process.env[key]?.trim()) {
      setEnv(key, generatePrivateKey());
      console.log(`Made a new ${key} in swarm/.env`);
    }
  }
  const treasuryKey = process.env.TREASURY_PRIVATE_KEY.trim();
  const sponsor = privateKeyToAccount(process.env.SPONSOR_PRIVATE_KEY.trim()).address;
  const treasury = privateKeyToAccount(treasuryKey).address;
  const rpcUrl = opts.rpc || process.env.CHAIN_RPC_URL?.trim() || CHAIN.rpcUrls.default.http[0];

  const pub = createPublicClient({ chain: CHAIN, transport: http(rpcUrl) });
  const need = parseEther(opts["sponsor-eth"]) + parseEther("0.005");
  const have = await pub.getBalance({ address: treasury });
  // The pool takes 99% of the seed, plus the hook's 0.1% cut of it.
  const seedUsdc = parseUnits(opts["seed-usdc"], 6);
  const usdcHeld = opts["test-usdc"] ? seedUsdc : await pub.readContract({
    address: USDC, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [treasury],
  });
  if (have < need || usdcHeld < seedUsdc) {
    console.error(`The treasury ${treasury} on Sepolia needs:`);
    if (have < need) console.error(`  about ${formatEther(need)} ETH (it has ${formatEther(have)}): ${opts["sponsor-eth"]} for the gas sponsor ${sponsor}, the rest for gas`);
    if (usdcHeld < seedUsdc) console.error(`  ${opts["seed-usdc"]} USDC (${USDC}; it has ${Number(usdcHeld) / 1e6}) to seed the pool`);
    console.error("Send it that and run this again.");
    process.exit(1);
  }

  console.log(`Deploying from the treasury ${treasury} (${formatEther(have)} ETH)`);
  const d = await deploy({
    treasuryKey, sponsor, rpcUrl, usdc: opts["test-usdc"] ? null : USDC,
    price: opts.price, tokenPrice: opts["token-price"], seedPiper: String(Number(opts["seed-usdc"]) / Number(opts.price)), sponsorEth: opts["sponsor-eth"],
  });
  writeFileSync(DEPLOYMENT, JSON.stringify(d, null, 2) + "\n");
  const explorer = CHAIN.blockExplorers.default.url;
  console.log(`\nDone, written to ${DEPLOYMENT}`);
  for (const k of ["piper", "usdc", "market", "hook", "router"]) console.log(`  ${k.padEnd(7)} ${explorer}/address/${d[k]}`);
}

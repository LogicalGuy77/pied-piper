// The tracker's side of the PIPER economy on Sepolia
// (chain/deploy.js deploys it all):
//
//  - Paid questions: a phone signs a PIPER payment of the most it will
//    spend on one answer (InferenceMarket.sol); the gas sponsor opens the
//    query on-chain, the answer runs up to maxPayment / price tokens, and the
//    sponsor settles it for the tokens the swarm ran, refunding the rest.
//  - Swaps: a phone signs its input token to the router (PiperRouter.sol),
//    with the least it accepts; the sponsor submits it. quote() prices one.
//  - The faucet: the treasury sends PIPER (and test USDC) to a phone, so it
//    can ask before it has earned anything.
//
// The sponsor pays the gas of everything a phone only signs; the pool's hook
// pays it a cut of every swap and deposit. Its transactions go out
// concurrently, with viem's nonce manager keeping their nonces in order.

import {
  BaseError, createPublicClient, createWalletClient, decodeEventLog, encodeAbiParameters, formatUnits, getAddress, http,
  isAddress, isHex, keccak256, nonceManager, parseAbi, parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN } from "./chain.js";

// The tokens' errors, which also come up through the market and the router.
const TOKEN_ERRORS = [
  "error AuthorizationNotYetValid()",
  "error AuthorizationExpired()",
  "error AuthorizationAlreadyUsed()",
  "error InvalidAuthorizationSignature()",
  "error CallerMustBePayee()",
  "error MintLimit()",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
];

export const ERC20_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
  "function version() view returns (string)",
  "function transfer(address, uint256) returns (bool)",
  "function mint(address, uint256)",
  ...TOKEN_ERRORS,
]);

export const MARKET_ABI = parseAbi([
  "function pricePerToken() view returns (uint256)",
  "function operator() view returns (address)",
  "function owner() view returns (address)",
  "function setPrice(uint256 pricePerToken)",
  "function queryId(address asker, bytes32 promptHash, bytes32 salt) pure returns (bytes32)",
  "function queries(bytes32) view returns (address asker, uint64 openedAt, bool closed, uint256 maxPayment, uint256 pricePerToken)",
  "function open(address asker, uint256 maxPayment, uint256 validBefore, bytes32 promptHash, bytes32 salt, bytes signature) returns (bytes32)",
  "function settle(bytes32 id, uint256 tokens)",
  "event QuerySettled(bytes32 indexed id, uint256 tokens, uint256 cost, uint256 refund)",
  "error QueryExists()",
  "error UnknownQuery()",
  "error QueryClosed()",
  "error NotOperator()",
  "error BelowOneToken()",
  ...TOKEN_ERRORS,
]);

export const ROUTER_ABI = parseAbi([
  "function swapWithAuthorization(address from, bool zeroForOne, uint256 amountIn, uint256 minOut, address to, uint256 validBefore, bytes32 salt, bytes signature) returns (uint256)",
  "function quote(bool zeroForOne, uint256 amountIn)",
  "event Swapped(address indexed payer, address indexed to, bool zeroForOne, uint256 amountIn, uint256 amountOut)",
  "error Quote(uint256 amountOut)",
  "error TooLittleReceived(uint256 amountOut, uint256 minOut)",
  ...TOKEN_ERRORS,
]);

const HOOK_ABI = parseAbi(["function collect(address currency) returns (uint256)"]);
const POOL_MANAGER_ABI = parseAbi([
  "function balanceOf(address owner, uint256 id) view returns (uint256)",
  "function extsload(bytes32) view returns (bytes32)",
]);

// What a phone sees when its signature is refused.
const REASONS = {
  AuthorizationAlreadyUsed: "this payment was already used",
  AuthorizationExpired: "the signature expired; try again",
  AuthorizationNotYetValid: "the signature isn't valid yet",
  InvalidAuthorizationSignature: "the signature doesn't match",
  ERC20InsufficientBalance: "not enough in this wallet",
  QueryExists: "this question was already paid for",
  BelowOneToken: "that doesn't pay for even one token",
  TooLittleReceived: "the price moved; try again",
  MintLimit: "too much at once",
};

export function createMarket({ deployment: d, sponsorKey, treasuryKey, rpcUrl, chain = CHAIN, log = console.log }) {
  const transport = http(rpcUrl);
  const pub = createPublicClient({ chain, transport });
  const sponsor = privateKeyToAccount(sponsorKey, { nonceManager });
  const treasury = treasuryKey ? privateKeyToAccount(treasuryKey, { nonceManager }) : null;
  const asSponsor = createWalletClient({ account: sponsor, chain, transport });
  const asTreasury = treasury ? createWalletClient({ account: treasury, chain, transport }) : null;
  const tokens = {};   // piper, usdc: { address, name, symbol, decimals, version, chainId }
  let price = 0n;      // PIPER base units per token
  let piperIs0 = true; // the pool's currency0 is PIPER
  const lastFaucet = new Map(); // address -> ms, for the phone's own USDC faucet

  async function init() {
    const read = (address, functionName) => pub.readContract({ address, abi: ERC20_ABI, functionName });
    const chainId = await pub.getChainId();
    for (const [key, address] of [["piper", d.piper], ["usdc", d.usdc]]) {
      const [name, symbol, decimals] = await Promise.all(["name", "symbol", "decimals"].map((f) => read(address, f)));
      // Circle's USDC has no eip712Domain(), only version(); its domain name is name().
      const version = await read(address, "eip712Domain").then((domain) => domain[2], () => read(address, "version"));
      tokens[key] = { address: getAddress(address), name, symbol, decimals, version, chainId };
    }
    price = await pub.readContract({ address: d.market, abi: MARKET_ABI, functionName: "pricePerToken" });
    const operator = await pub.readContract({ address: d.market, abi: MARKET_ABI, functionName: "operator" });
    if (getAddress(operator) !== sponsor.address) {
      throw new Error(`the market's operator is ${operator}, not this tracker's sponsor ${sponsor.address}`);
    }
    piperIs0 = BigInt(d.piper) < BigInt(d.usdc);
  }

  // Simulates first, so a refused signature costs no gas and reads as a reason.
  async function submit(client, request) {
    let simulated;
    try {
      ({ request: simulated } = await pub.simulateContract({ ...request, account: client.account }));
    } catch (err) {
      throw explain(err);
    }
    const hash = await client.writeContract(simulated);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
    return { hash, receipt };
  }

  // Questions already open keep the price they opened at. Returns the hash, or null if unchanged.
  async function setPrice(pricePerToken) {
    if (pricePerToken === price) return null;
    if (!asTreasury) throw new Error("setting the price needs TREASURY_PRIVATE_KEY");
    const owner = await pub.readContract({ address: d.market, abi: MARKET_ABI, functionName: "owner" });
    if (getAddress(owner) !== treasury.address) throw new Error(`the market's owner is ${owner}, not the treasury ${treasury.address}`);
    const { hash } = await submit(asTreasury, { address: d.market, abi: MARKET_ABI, functionName: "setPrice", args: [pricePerToken] });
    price = pricePerToken;
    return hash;
  }

  // p: { maxPayment, validBefore, promptHash, salt, signature } from the asker,
  // whose wallet is `asker`. Returns { id, maxTokens, maxPayment, hash }.
  async function openQuery(asker, p) {
    if (!isHex(p?.promptHash) || p.promptHash.length !== 66 || !isHex(p?.salt) || p.salt.length !== 66 || !isHex(p?.signature)) {
      throw new Error("bad payment");
    }
    const maxPayment = BigInt(p.maxPayment);
    const args = [asker, maxPayment, BigInt(p.validBefore), p.promptHash, p.salt, p.signature];
    const { hash } = await submit(asSponsor, { address: d.market, abi: MARKET_ABI, functionName: "open", args });
    const id = await pub.readContract({ address: d.market, abi: MARKET_ABI, functionName: "queryId", args: [asker, p.promptHash, p.salt] });
    return { id, maxTokens: Number(maxPayment / price), maxPayment: String(maxPayment), price: String(price), hash };
  }

  async function settleQuery(id, used) {
    const { hash, receipt } = await submit(asSponsor, {
      address: d.market, abi: MARKET_ABI, functionName: "settle", args: [id, BigInt(Math.max(0, Math.round(used)))],
    });
    const settled = receipt.logs.map(decodeSettled).find(Boolean);
    return { hash, cost: String(settled?.cost ?? 0n), refund: String(settled?.refund ?? 0n), tokens: used };
  }

  function decodeSettled(entry) {
    try {
      const e = decodeEventLog({ abi: MARKET_ABI, data: entry.data, topics: entry.topics });
      return e.eventName === "QuerySettled" ? e.args : null;
    } catch {
      return null;
    }
  }

  // side "buy": USDC in, PIPER out; "sell": PIPER in, USDC out.
  const zeroForOne = (side) => (side === "sell") === piperIs0;

  async function quote(side, amountIn) {
    try {
      await pub.simulateContract({ address: d.router, abi: ROUTER_ABI, functionName: "quote", args: [zeroForOne(side), BigInt(amountIn)], account: sponsor });
    } catch (err) {
      const q = err instanceof BaseError ? err.walk((e) => e.data?.errorName === "Quote") : null;
      if (q) return q.data.args[0];
      throw explain(err);
    }
    throw new Error("the router quoted nothing");
  }

  // s: { side, amountIn, minOut, validBefore, salt, signature }; the output goes back to owner.
  async function swap(owner, s) {
    if (s?.side !== "buy" && s?.side !== "sell") throw new Error("bad swap");
    if (!isHex(s.salt) || s.salt.length !== 66 || !isHex(s.signature)) throw new Error("bad swap");
    const args = [owner, zeroForOne(s.side), BigInt(s.amountIn), BigInt(s.minOut), owner, BigInt(s.validBefore), s.salt, s.signature];
    const { hash, receipt } = await submit(asSponsor, { address: d.router, abi: ROUTER_ABI, functionName: "swapWithAuthorization", args });
    let amountOut = 0n;
    for (const entry of receipt.logs) {
      try {
        const e = decodeEventLog({ abi: ROUTER_ABI, data: entry.data, topics: entry.topics });
        if (e.eventName === "Swapped") amountOut = e.args.amountOut;
      } catch {}
    }
    return { hash, amountOut: String(amountOut) };
  }

  // The treasury sends PIPER to a phone; with the test USDC, mints it some too.
  async function faucet(to, { piper = "0", usdc = "0" } = {}) {
    if (!asTreasury) throw new Error("the faucet needs TREASURY_PRIVATE_KEY");
    if (!isAddress(to)) throw new Error("no wallet to send to");
    const out = {};
    if (Number(piper) > 0) {
      out.piper = (await submit(asTreasury, {
        address: d.piper, abi: ERC20_ABI, functionName: "transfer", args: [getAddress(to), parseUnits(piper, 18)],
      })).hash;
    }
    if (Number(usdc) > 0) {
      if (!d.testUsdc) throw new Error("this USDC can't be minted");
      out.usdc = (await submit(asTreasury, {
        address: d.usdc, abi: ERC20_ABI, functionName: "mint", args: [getAddress(to), parseUnits(usdc, 6)],
      })).hash;
    }
    return out;
  }

  // A phone asks for test USDC itself: once every `every` ms, the sponsor mints it.
  async function usdcFaucet(to, amount = "100", every = 3600000) {
    if (!d.testUsdc) throw new Error("this USDC can't be minted");
    const since = Date.now() - (lastFaucet.get(to) ?? -Infinity);
    if (since < every) throw new Error(`one USDC top-up an hour; try again in ${Math.ceil((every - since) / 60000)} min`);
    lastFaucet.set(to, Date.now());
    return (await submit(asSponsor, { address: d.usdc, abi: ERC20_ABI, functionName: "mint", args: [to, parseUnits(amount, 6)] })).hash;
  }

  async function balances(address) {
    const read = (token) => pub.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [address] });
    const [piper, usdc] = await Promise.all([read(d.piper), read(d.usdc)]);
    return { piper: String(piper), usdc: String(usdc) };
  }

  // PIPER's price in USDC from the pool's current sqrt price, read from the
  // PoolManager's storage (StateLibrary: pools mapping at slot 6).
  async function poolPrice() {
    const poolId = keccak256(encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [d.pool.currency0, d.pool.currency1, d.pool.fee, d.pool.tickSpacing, d.pool.hooks],
    ));
    const slot = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId, 6n]));
    const word = await pub.readContract({ address: d.poolManager, abi: POOL_MANAGER_ABI, functionName: "extsload", args: [slot] });
    const sqrtPriceX96 = BigInt(word) & ((1n << 160n) - 1n);
    const raw = Number(sqrtPriceX96) / 2 ** 96;
    const p = raw * raw; // currency1 units per currency0 unit
    return piperIs0 ? p * 1e12 : 1 / (p * 1e-12);
  }

  // Deposits' cuts wait in the hook as PoolManager claims; this sends them on.
  async function collectFees() {
    const hashes = [];
    for (const token of [d.piper, d.usdc]) {
      const claims = await pub.readContract({ address: d.poolManager, abi: POOL_MANAGER_ABI, functionName: "balanceOf", args: [d.hook, BigInt(token)] });
      if (claims > 0n) hashes.push((await submit(asSponsor, { address: d.hook, abi: HOOK_ABI, functionName: "collect", args: [token] })).hash);
    }
    return hashes;
  }

  async function sponsorStatus() {
    const [eth, b] = await Promise.all([pub.getBalance({ address: sponsor.address }), balances(sponsor.address)]);
    return { address: sponsor.address, eth: formatUnits(eth, 18), piper: formatUnits(BigInt(b.piper), 18), usdc: formatUnits(BigInt(b.usdc), 6) };
  }

  function info() {
    return {
      piper: tokens.piper ?? null,
      usdc: tokens.usdc ? { ...tokens.usdc, test: !!d.testUsdc } : null,
      market: d.market,
      router: d.router,
      hook: d.hook,
      sponsor: sponsor.address,
      pricePerToken: String(price),
      tokenPrice: formatUnits(price, 18),
      pool: d.pool,
      explorer: chain.blockExplorers?.default.url ?? null,
    };
  }

  return {
    init, info, setPrice, openQuery, settleQuery, quote, swap, faucet, usdcFaucet, balances, poolPrice, collectFees, sponsorStatus, sponsor: sponsor.address,
  };
}

// The custom error a contract reverted with, as words a phone can show.
function explain(err) {
  const name = err instanceof BaseError ? err.walk((e) => e.data?.errorName)?.data.errorName : null;
  return name && REASONS[name] ? new Error(REASONS[name]) : err;
}

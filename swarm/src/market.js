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
// The PoolManager's events for one pool. Swap amounts are the swapper's:
// positive is what it got out, before the hook's cut.
const POOL_EVENTS = parseAbi([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
  "event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)",
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
]);
const HISTORY_KEPT = 500;     // pool events kept, newest last
const LOG_CHUNK = 10000n;     // blocks per getLogs
const HOOK_SWAP_FEE = 0.002;  // GasSponsorHook's cut of a swap's output
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
  const poolId = keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [d.pool.currency0, d.pool.currency1, d.pool.fee, d.pool.tickSpacing, d.pool.hooks],
  ));
  // StateLibrary: the pools mapping is at slot 6; slot0 first, liquidity 3 words on.
  const stateSlot = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId, 6n])));
  const history = { scannedTo: null, events: [], blockTimes: new Map(), readAt: 0, job: null };

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
    history.readAt = 0;
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

  const word = (slot) => pub.readContract({ address: d.poolManager, abi: POOL_MANAGER_ABI, functionName: "extsload", args: [toHex32(slot)] });

  // USDC per PIPER at a sqrt price: sqrt(currency1 units per currency0 unit) as a float.
  const priceAt = (s) => (piperIs0 ? s * s * 1e12 : 1 / (s * s * 1e-12));
  const sqrtOf = (sqrtPriceX96) => Number(sqrtPriceX96) / 2 ** 96;

  // PIPER's price in USDC from the pool's current sqrt price, read from the PoolManager's storage.
  async function poolPrice() {
    return priceAt(sqrtOf(BigInt(await word(stateSlot)) & ((1n << 160n) - 1n)));
  }

  // The pool now: price, tick, liquidity, and the PIPER and USDC its
  // full-range liquidity holds (L / sqrt P of currency0, L * sqrt P of currency1).
  async function poolState() {
    const [slot0, liq] = await Promise.all([word(stateSlot), word(stateSlot + 3n)]);
    const sqrtPriceX96 = BigInt(slot0) & ((1n << 160n) - 1n);
    const tick = Number(BigInt.asIntN(24, BigInt(slot0) >> 160n));
    const liquidity = BigInt(liq) & ((1n << 128n) - 1n);
    const s = sqrtOf(sqrtPriceX96);
    const [piperRaw, usdcRaw] = piperIs0 ? [Number(liquidity) / s, Number(liquidity) * s] : [Number(liquidity) * s, Number(liquidity) / s];
    const piper = piperRaw / 1e18, usdc = usdcRaw / 1e6, price = priceAt(s);
    return {
      poolId, price, tick, liquidity: String(liquidity), sqrtPriceX96: String(sqrtPriceX96),
      piper, usdc, tvlUsdc: usdc + piper * price,
      fees: { lp: d.pool.fee / 1e6, hookSwap: HOOK_SWAP_FEE, hookDeposit: 0.001 },
    };
  }

  // quote(), plus what it means: the pool's price before, the price this
  // swap gets after every fee, how far that is from the pool's, and the pool's
  // price after it (full-range math: currency0 in moves 1/sqrt P up by
  // in / L, currency1 in moves sqrt P up by in / L).
  async function quoteDetails(side, amountIn) {
    const [out, state] = await Promise.all([quote(side, amountIn), poolState()]);
    const L = Number(state.liquidity);
    const s = sqrtOf(BigInt(state.sqrtPriceX96));
    const inRaw = Number(amountIn) * (1 - state.fees.lp);
    const after = zeroForOne(side) ? priceAt(L / (L / s + inRaw)) : priceAt(s + inRaw / L);
    const [piper, usdc] = side === "buy" ? [Number(out) / 1e18, Number(amountIn) / 1e6] : [Number(amountIn) / 1e18, Number(out) / 1e6];
    const rate = piper > 0 ? usdc / piper : null;
    return {
      amountOut: String(out), side, price: state.price, rate, priceAfter: after,
      // How much worse than the pool's price, fees included: buyers pay more, sellers get less.
      cost: rate == null ? null : side === "buy" ? rate / state.price - 1 : 1 - rate / state.price,
      move: after / state.price - 1,
    };
  }

  // The pool's opening, deposits and swaps, read from the PoolManager's
  // events since the deployment and then only the new blocks; cached 10 s.
  function poolHistory() {
    if (history.job) return history.job;
    if (Date.now() - history.readAt < 10000) return Promise.resolve(historyView());
    history.job = (async () => {
      const latest = await pub.getBlockNumber();
      let from = history.scannedTo != null ? history.scannedTo + 1n : BigInt(d.block ?? 0) - 1000n;
      if (from < 0n) from = 0n;
      const logs = [];
      for (let start = from; start <= latest; start += LOG_CHUNK) {
        const end = start + LOG_CHUNK - 1n < latest ? start + LOG_CHUNK - 1n : latest;
        logs.push(...await pub.getLogs({ address: d.poolManager, events: POOL_EVENTS, args: { id: poolId }, fromBlock: start, toBlock: end }));
      }
      const blocks = [...new Set(logs.map((l) => l.blockNumber))].filter((b) => !history.blockTimes.has(b));
      await Promise.all(blocks.map(async (b) => history.blockTimes.set(b, Number((await pub.getBlock({ blockNumber: b })).timestamp) * 1000)));
      for (const l of logs) history.events.push(poolEvent(l, history.events.at(-1)?.price ?? null));
      history.events.splice(0, Math.max(0, history.events.length - HISTORY_KEPT));
      history.scannedTo = latest;
      history.readAt = Date.now();
      return historyView();
    })().finally(() => (history.job = null));
    return history.job;
  }

  function poolEvent(l, lastPrice) {
    const base = { block: Number(l.blockNumber), at: history.blockTimes.get(l.blockNumber), tx: l.transactionHash };
    const a = l.args;
    if (l.eventName === "Initialize") return { ...base, type: "open", price: priceAt(sqrtOf(a.sqrtPriceX96)) };
    if (l.eventName === "ModifyLiquidity") {
      const s = lastPrice == null ? null : piperIs0 ? Math.sqrt(lastPrice / 1e12) : Math.sqrt(1 / (lastPrice * 1e-12));
      const L = Math.abs(Number(a.liquidityDelta));
      const [p0, p1] = s ? [L / s, L * s] : [null, null];
      const [piper, usdc] = piperIs0 ? [p0, p1] : [p1, p0];
      return { ...base, type: a.liquidityDelta >= 0n ? "deposit" : "withdraw", price: lastPrice,
        piper: piper == null ? null : piper / 1e18, usdc: usdc == null ? null : usdc / 1e6 };
    }
    const [piperDelta, usdcDelta] = piperIs0 ? [a.amount0, a.amount1] : [a.amount1, a.amount0];
    return {
      ...base, type: piperDelta > 0n ? "buy" : "sell", price: priceAt(sqrtOf(a.sqrtPriceX96)),
      piper: Math.abs(Number(piperDelta)) / 1e18, usdc: Math.abs(Number(usdcDelta)) / 1e6,
    };
  }

  function historyView() {
    return { events: history.events, scannedTo: history.scannedTo == null ? null : Number(history.scannedTo), readAt: history.readAt };
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
    init, info, setPrice, openQuery, settleQuery, quote, quoteDetails, swap, faucet, usdcFaucet, balances,
    poolPrice, poolState, poolHistory, collectFees, sponsorStatus, sponsor: sponsor.address,
  };
}

const toHex32 = (n) => `0x${n.toString(16).padStart(64, "0")}`;

// The custom error a contract reverted with, as words a phone can show.
function explain(err) {
  const name = err instanceof BaseError ? err.walk((e) => e.data?.errorName)?.data.errorName : null;
  return name && REASONS[name] ? new Error(REASONS[name]) : err;
}

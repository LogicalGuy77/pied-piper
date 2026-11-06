// The PIPER economy on a local chain: the contracts of swarm/chain and the
// tracker's side of them (src/market.js).
//
//  1. Deploying: the hook sits at an address with its flags, the pool opens
//     at the asked price, and the seed deposit already paid the sponsor.
//  2. Swaps with no ETH: a wallet holding only USDC buys PIPER with one
//     signature; the sponsor gets the hook's cut; a replay, a changed
//     minimum and a minimum above the quote are refused.
//  3. Paid questions: an asker escrows the most it will pay; settling pays
//     the treasury for the tokens run and refunds the rest; it can't be
//     settled twice, by anyone else, or opened with a changed prompt.
//  4. The faucet: the treasury sends PIPER and test USDC to a phone.
//
//   node test/market-check.js RPC_URL
//   RPC_URL: a chain with id 11155111 and Hardhat's funded accounts, e.g.
//   npx hardhat node with chainId 11155111 and hardfork cancun.

import { createPublicClient, createWalletClient, formatUnits, http, keccak256, parseUnits, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CHAIN } from "../src/chain.js";

import { createMarket, ERC20_ABI, MARKET_ABI } from "../src/market.js";
import { queryId, randomBytes32, receiveTypedData, swapNonce } from "../wallet/typed-data.js";
import { deployLocal, SPONSOR_KEY, TREASURY_KEY } from "./local-chain.js";

const RPC = process.argv[2];
if (!RPC) {
  console.error("usage: node test/market-check.js RPC_URL");
  process.exit(1);
}

const results = [];
function check(name, ok, detail = "") {
  results.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
async function refused(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err.shortMessage ?? err.message;
  }
}

const transport = http(RPC);
const pub = createPublicClient({ chain: CHAIN, transport });
const balance = (token, a) => pub.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [a] });
const hour = () => BigInt(Math.floor(Date.now() / 1000) + 3600);

console.log("1. Deploying");
const t0 = Date.now();
const d = await deployLocal(RPC);
const market = createMarket({ deployment: d, sponsorKey: SPONSOR_KEY, treasuryKey: TREASURY_KEY, rpcUrl: RPC, log: () => {} });
await market.init();
const info = market.info();
check(`everything deploys (${((Date.now() - t0) / 1000).toFixed(1)} s)`, !!(d.piper && d.usdc && d.market && d.hook && d.router));
check("the hook's address carries its v4 flags (0x446)", (BigInt(d.hook) & 0x3fffn) === 0x446n, d.hook);
const price = await market.poolPrice();
check("the pool opens at 0.01 USDC per PIPER", Math.abs(price - 0.01) < 1e-9, price);
const seedFee = { piper: await balance(d.piper, d.sponsor), usdc: await balance(d.usdc, d.sponsor) };
// The deposit is 99% of the seed (deploy.js leaves room for the cut), so the cut is 0.1% of that.
check("the seed deposit paid the sponsor the hook's 0.1% of each side",
  seedFee.piper >= parseUnits("989", 18) && seedFee.piper <= parseUnits("1000", 18) && seedFee.usdc >= parseUnits("9.89", 6) && seedFee.usdc <= parseUnits("10", 6),
  `${formatUnits(seedFee.piper, 18)} PIPER, ${formatUnits(seedFee.usdc, 6)} USDC`);

console.log("2. Swapping with no ETH");
{
  const trader = privateKeyToAccount(generatePrivateKey());
  await market.faucet(trader.address, { usdc: "100" });
  const amountIn = parseUnits("10", 6);
  const quoted = await market.quote("buy", amountIn);
  // 10 USDC at 0.01 is 1000 PIPER, less the 0.3% LP fee, the 0.2% hook cut and a little price impact.
  check("10 USDC is quoted at a little under 1000 PIPER", quoted > parseUnits("990", 18) && quoted < parseUnits("995", 18), formatUnits(quoted, 18));

  const sign = async (side, value, minOut, salt = randomBytes32()) => {
    const token = side === "buy" ? info.usdc : info.piper;
    const zeroForOne = (side === "sell") === (BigInt(d.piper) < BigInt(d.usdc));
    const nonce = swapNonce(trader.address, zeroForOne, minOut, trader.address, salt);
    const validBefore = hour();
    const signature = await trader.signTypedData(receiveTypedData(token, { from: trader.address, to: d.router, value, validAfter: 0n, validBefore, nonce }));
    return { side, amountIn: String(value), minOut: String(minOut), validBefore: String(validBefore), salt, signature };
  };
  const sponsorBefore = await balance(d.piper, d.sponsor);
  const ethBefore = await pub.getBalance({ address: trader.address });
  const minOut = (quoted * 99n) / 100n;
  const s = await sign("buy", amountIn, minOut);
  const result = await market.swap(trader.address, s);
  const got = await balance(d.piper, trader.address);
  check("one signature buys PIPER, and the trader paid no gas",
    got === BigInt(result.amountOut) && got === quoted && (await pub.getBalance({ address: trader.address })) === ethBefore && ethBefore === 0n,
    `${formatUnits(got, 18)} PIPER`);
  check("the trader paid exactly 10 USDC", (await balance(d.usdc, trader.address)) === parseUnits("90", 6));
  const cut = (await balance(d.piper, d.sponsor)) - sponsorBefore;
  check("the hook sent 0.2% of the output to the gas sponsor", cut > 0n && cut === ((got + cut) * 20n) / 10000n, `${formatUnits(cut, 18)} PIPER`);
  check("the same signature can't swap again", !!(await refused(market.swap(trader.address, s))));
  check("nor with a lower minimum than signed", !!(await refused(market.swap(trader.address, { ...s, minOut: "0" }))));
  const greedy = await sign("buy", amountIn, quoted * 2n);
  check("a minimum above what the pool gives is refused", /price moved/.test((await refused(market.swap(trader.address, greedy))) ?? ""));

  const sellIn = got / 2n;
  const sellQuote = await market.quote("sell", sellIn);
  await market.swap(trader.address, await sign("sell", sellIn, (sellQuote * 99n) / 100n));
  check("selling PIPER back for USDC works too", (await balance(d.usdc, trader.address)) === parseUnits("90", 6) + sellQuote,
    `${formatUnits(sellQuote, 6)} USDC for ${formatUnits(sellIn, 18)} PIPER`);
}

console.log("3. Paying for a question");
{
  const asker = privateKeyToAccount(generatePrivateKey());
  await market.faucet(asker.address, { piper: "10" });
  const promptHash = keccak256(toHex("What is the capital of France?"));
  const pay = async (maxPayment, hash = promptHash, salt = randomBytes32()) => {
    const validBefore = hour();
    const nonce = queryId(asker.address, hash, salt);
    const signature = await asker.signTypedData(receiveTypedData(info.piper, {
      from: asker.address, to: d.market, value: maxPayment, validAfter: 0n, validBefore, nonce,
    }));
    return { maxPayment: String(maxPayment), validBefore: String(validBefore), promptHash: hash, salt, signature };
  };
  const p = await pay(parseUnits("5", 18));
  check("a changed prompt doesn't match the signature", !!(await refused(market.openQuery(asker.address, { ...p, promptHash: keccak256(toHex("other")) }))));
  const q = await market.openQuery(asker.address, p);
  check("5 PIPER at 0.2 a token is a 25-token limit", q.maxTokens === 25, q.maxTokens);
  check("the 5 PIPER are escrowed", (await balance(d.piper, asker.address)) === parseUnits("5", 18) && (await balance(d.piper, d.market)) === parseUnits("5", 18));
  check("the same payment can't open a second query", !!(await refused(market.openQuery(asker.address, p))));

  const stranger = createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: CHAIN, transport });
  check("nobody but the operator settles",
    !!(await refused(pub.simulateContract({ account: stranger.account, address: d.market, abi: MARKET_ABI, functionName: "settle", args: [q.id, 0n] }))));
  const treasuryBefore = await balance(d.piper, d.treasury);
  const s = await market.settleQuery(q.id, 12);
  check("12 tokens cost 2.4 PIPER to the treasury and refund 2.6",
    s.cost === String(parseUnits("2.4", 18)) && s.refund === String(parseUnits("2.6", 18))
    && (await balance(d.piper, d.treasury)) - treasuryBefore === parseUnits("2.4", 18)
    && (await balance(d.piper, asker.address)) === parseUnits("7.6", 18));
  check("a settled query can't be settled again", !!(await refused(market.settleQuery(q.id, 1))));

  const q2 = await market.openQuery(asker.address, await pay(parseUnits("1", 18)));
  const s2 = await market.settleQuery(q2.id, 500);
  check("running past the limit costs no more than the payment", s2.cost === String(parseUnits("1", 18)) && s2.refund === "0");
  check("the asker never held ETH", (await pub.getBalance({ address: asker.address })) === 0n);
}

console.log("4. The faucet");
{
  const phone = privateKeyToAccount(generatePrivateKey()).address;
  await market.faucet(phone, { piper: "25", usdc: "5" });
  const b = await market.balances(phone);
  check("the treasury sends a phone PIPER and test USDC", b.piper === String(parseUnits("25", 18)) && b.usdc === String(parseUnits("5", 6)));
  await market.usdcFaucet(phone, "100");
  check("a phone tops up its own test USDC once", !!(await refused(market.usdcFaucet(phone, "100"))));
  const sponsor = await market.sponsorStatus();
  check("the sponsor's balances read", Number(sponsor.piper) > 0 && Number(sponsor.usdc) > 0, `${sponsor.piper} PIPER, ${sponsor.usdc} USDC`);
}

const failed = results.filter((ok) => !ok).length;
console.log(failed ? `\n${failed} of ${results.length} checks FAILED` : `\nAll ${results.length} checks passed`);
process.exit(failed ? 1 : 0);

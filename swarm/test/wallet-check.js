// Wallet, rewards and paid-question checks.
//
//  1. A phone links its wallet by signing the tracker's challenge; a wrong
//     signer or another connection's challenge is refused.
//  2. Earnings: parameter-ops times the reward, exact to the base unit, kept
//     in a ledger that survives a restart; a ledger in old units is moved aside.
// With a chain (an RPC whose chain id is Sepolia's 11155111, e.g. a
// local Hardhat node started with chainId 11155111 and hardfork cancun):
//  3. Deploy everything (test/local-chain.js); a payout round pays everyone
//     due in one transaction.
//  4. A round sent before a crash is settled on restart, never paid twice.
//  5. Withdrawing with a signed TransferWithAuthorization: it arrives and the
//     gas sponsor pays its gas; a replay, a changed recipient, or someone
//     else's wallet are refused.
//  6. The real tracker: the faucet funds an asker, a question too long for
//     its payment is refunded, a paid answer stops at its token limit, a
//     short one is charged for what it ran; the phones that served get paid
//     by their blocks' parameters; a phone buys PIPER with test USDC and
//     withdraws, all without ETH.
//
//   node test/wallet-check.js [RPC_URL]
//   RPC_URL needs funded accounts 0 and 1 of the standard test mnemonic (Hardhat's).

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, formatUnits, http, keccak256, parseUnits, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CHAIN } from "../src/chain.js";

import { paramsModel } from "../src/blocks.js";
import { Peer } from "../src/peer.js";
import { createRewards, TOKEN_ABI } from "../src/rewards.js";
import { newNonce, verifyWallet, walletChallenge } from "../src/wallet-auth.js";
import { queryId, randomBytes32, receiveTypedData, swapNonce, transferTypedData } from "../wallet/typed-data.js";
import { deployLocal, SPONSOR_KEY, TREASURY_KEY } from "./local-chain.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const RPC = process.argv[2] ?? null;
const WEIGHTS = join(ROOT, "weights", "smollm2-135m-instruct");

const results = [];
function check(name, ok, detail = "") {
  results.push(ok);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(50)) if (await cond()) return true;
  return cond();
}
async function refused(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err.shortMessage ?? err.message;
  }
}
const tmp = mkdtempSync(join(tmpdir(), "pied-piper-wallet-"));
const quiet = () => {};
const PIPER = (x) => parseUnits(String(x), 18);

console.log("1. Linking a wallet");
{
  const phone = privateKeyToAccount(generatePrivateKey());
  const other = privateKeyToAccount(generatePrivateKey());
  const nonce = newNonce();
  const signature = await phone.signMessage({ message: walletChallenge("A", nonce) });
  const address = await verifyWallet({ address: phone.address, signature }, { peerId: "A", nonce }).catch(() => null);
  check("the phone's signature of its challenge links its wallet", address === phone.address);
  const wrongSigner = await refused(verifyWallet({ address: other.address, signature }, { peerId: "A", nonce }));
  const otherNonce = await refused(verifyWallet({ address: phone.address, signature }, { peerId: "A", nonce: newNonce() }));
  const otherPeer = await refused(verifyWallet({ address: phone.address, signature }, { peerId: "B", nonce }));
  check("someone else's wallet, another connection's or another phone's challenge are refused",
    !!wrongSigner && !!otherNonce && !!otherPeer, wrongSigner);
}

console.log("2. Earnings and the ledger");
{
  const params = paramsModel(JSON.parse(readFileSync(join(WEIGHTS, "manifest.json"), "utf8")));
  const whole = params({ start: 0, end: 30 });
  check("SmolLM2's 30 layers and output head are 134.5 M parameters a token", whole === 30 * 3540096 + 49152 * 576, whole);

  const file = join(tmp, "ledger-2.json");
  const r = createRewards({ file, log: quiet }); // 1 PIPER per 1e9 parameter-ops
  const a = privateKeyToAccount(generatePrivateKey()).address;
  const block = params({ start: 0, end: 10 });
  r.credit(a, 8 * block); // 8 tokens through layers 0-9
  const expected = (BigInt(8 * block) * PIPER(1)) / 10n ** 9n;
  check("8 tokens through a 10-layer block earn 8 x 35.4 M / 1e9 PIPER", BigInt(r.status(a).pending) === expected, formatUnits(BigInt(r.status(a).pending), 18));
  r.flush();
  const again = createRewards({ file, log: quiet });
  check("the ledger survives a restart", BigInt(again.status(a).pending) === expected && again.status(a).params === 8 * block);

  // 1 PIPER per 3e9: a single parameter-op is a third of a base unit's billionth, never whole.
  const thirds = createRewards({ file: join(tmp, "ledger-2b.json"), unitParams: 3e9, log: quiet });
  for (let i = 0; i < 3000; i++) thirds.credit(a, 1);
  check("fractions of a unit carry over: 3000 single ops at 1 PIPER per 3e9 pay exactly 1e-6 PIPER",
    thirds.status(a).pending === String(PIPER("0.000001")), thirds.status(a).pending);

  const oldFile = join(tmp, "ledger-old.json");
  writeFileSync(oldFile, JSON.stringify({ decimals: 6, accounts: { [a]: { pending: "1000", paid: "0", layerTokens: 1000 } } }));
  const lines = [];
  const fresh = createRewards({ file: oldFile, log: (l) => lines.push(l) });
  check("a ledger kept in other units (the old pUSDC) is moved aside, not misread",
    fresh.status(a).pending === "0" && existsSync(`${oldFile}.old`) && /moved it/.test(lines.join()), lines[0]);
}

if (!RPC) {
  console.log("(no RPC given: skipping the on-chain checks 3-6)");
} else {
  const transport = http(RPC);
  const pub = createPublicClient({ chain: CHAIN, transport });
  const balanceOf = (token, a) => pub.readContract({ address: token, abi: TOKEN_ABI, functionName: "balanceOf", args: [a] });

  console.log("3. Deploying and paying out");
  const d = await deployLocal(RPC);
  check("PIPER deploys with the supply in the treasury, less the pool's seed",
    (await balanceOf(d.piper, d.treasury)) > PIPER(98_000_000), d.piper);
  const chain = { privateKey: TREASURY_KEY, relayerKey: SPONSOR_KEY, rpcUrl: RPC, token: d.piper };
  const file = join(tmp, "ledger-3.json");
  const r = createRewards({ file, payoutMin: "0.01", chain, withdrawEvery: 0, log: quiet });
  await r.init();
  const phones = [0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey()));
  r.credit(phones[0].address, 1e9);  // 1 PIPER
  r.credit(phones[1].address, 2e7);  // 0.02
  r.credit(phones[2].address, 5e6);  // 0.005: below the minimum, waits
  const before = await pub.getBlockNumber({ cacheTime: 0 });
  const paid = await r.payout();
  const after = await pub.getBlockNumber({ cacheTime: 0 });
  const balances = await Promise.all(phones.map((p) => balanceOf(d.piper, p.address)));
  check("one transaction pays everyone above the minimum",
    paid.length === 2 && after === before + 1n && balances[0] === PIPER(1) && balances[1] === PIPER("0.02") && balances[2] === 0n,
    balances.map((b) => formatUnits(b, 18)).join(", "));
  check("paid moves out of pending; below the minimum stays pending",
    r.status(phones[0].address).pending === "0" && r.status(phones[0].address).paid === String(PIPER(1))
    && r.status(phones[2].address).pending === String(PIPER("0.005")));
  check("the next round has nothing to pay", (await r.payout()).length === 0);

  console.log("4. A round in flight across a restart");
  {
    const crashFile = join(tmp, "ledger-4.json");
    const p = privateKeyToAccount(generatePrivateKey()).address;
    const amount = PIPER("0.5");
    // The treasury sent the round, then the tracker died before settling it.
    const treasury = createWalletClient({ account: privateKeyToAccount(TREASURY_KEY), chain: CHAIN, transport });
    const hash = await treasury.writeContract({ address: d.piper, abi: TOKEN_ABI, functionName: "transferMany", args: [[p], [amount]] });
    writeFileSync(crashFile, JSON.stringify({
      decimals: 18,
      rate: "1/1000000000",
      accounts: { [p]: { pending: String(amount), paid: "0", carry: "0", params: 5e8 } },
      inflight: { hash, amounts: { [p]: String(amount) } },
    }));
    const restarted = createRewards({ file: crashFile, chain, log: quiet });
    await restarted.init();
    const s = restarted.status(p);
    const ledger = JSON.parse(readFileSync(crashFile, "utf8"));
    check("on restart the round is settled from its receipt", s.pending === "0" && s.paid === String(amount) && ledger.inflight === null);
    check("and not paid again", (await restarted.payout()).length === 0 && (await balanceOf(d.piper, p)) === amount);
  }

  console.log("5. Withdrawing");
  {
    const token = r.info().token;
    const phone = phones[0];
    const dest = privateKeyToAccount(generatePrivateKey()).address;
    const auth = (to, value) => ({
      from: phone.address, to, value, validAfter: 0n, validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600), nonce: `0x${newNonce()}${newNonce()}`,
    });
    const message = (a, signature) => ({ ...a, value: String(a.value), validAfter: "0", validBefore: String(a.validBefore), signature });
    const a = auth(dest, PIPER("0.4"));
    const signature = await phone.signTypedData(transferTypedData(token, a));
    const [treasuryEth, sponsorEth] = await Promise.all([pub.getBalance({ address: d.treasury }), pub.getBalance({ address: d.sponsor })]);
    const hash = await r.withdraw(phone.address, message(a, signature)).catch((err) => err.message);
    check("a signed withdrawal arrives, and the phone's wallet pays no gas",
      (await balanceOf(d.piper, dest)) === PIPER("0.4") && (await pub.getBalance({ address: phone.address })) === 0n, hash);
    check("the gas sponsor paid its gas, not the treasury",
      (await pub.getBalance({ address: d.sponsor })) < sponsorEth && (await pub.getBalance({ address: d.treasury })) === treasuryEth);
    check("its balance is read again after", r.status(phone.address).balance === String(PIPER("0.6")));
    const replay = await refused(r.withdraw(phone.address, message(a, signature)));
    check("the same signature again is refused", /already sent/.test(replay ?? ""), replay);
    const b = auth(dest, PIPER("0.1"));
    const sigB = await phone.signTypedData(transferTypedData(token, b));
    const redirected = await refused(r.withdraw(phone.address, message({ ...b, to: d.treasury }, sigB)));
    check("changing the recipient breaks the signature", /doesn't match/.test(redirected ?? ""), redirected);
    const notYours = await refused(r.withdraw(phones[1].address, message(b, sigB)));
    check("a phone can't withdraw from another phone's wallet", /only withdraw from this phone's wallet/.test(notYours ?? ""), notYours);
    const tooMuch = auth(dest, PIPER(5));
    const sigC = await phone.signTypedData(transferTypedData(token, tooMuch));
    const over = await refused(r.withdraw(phone.address, message(tooMuch, sigC)));
    check("more than the balance is refused before anything is sent", /not that much/.test(over ?? ""), over);
  }

  console.log("6. The tracker: faucet, paid questions, rewards, a swap, a withdrawal");
  await trackerCheck(d, balanceOf);
}

async function trackerCheck(d, balanceOf) {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const server = `http://localhost:${port}`;
  const deploymentFile = join(tmp, "deployment.json");
  writeFileSync(deploymentFile, JSON.stringify(d));
  const MANAGE_KEY = "test-manage-key";
  const tracker = spawn(process.execPath, [
    join(ROOT, "swarm", "tracker.js"), "--port", String(port), "--host", "127.0.0.1", "--min-replica", "1", "--weights", WEIGHTS,
    "--payout-every", "1000", "--payout-min", "0.0001", "--ledger", join(tmp, "ledger-6.json"),
  ], {
    env: {
      ...process.env, TREASURY_PRIVATE_KEY: TREASURY_KEY, SPONSOR_PRIVATE_KEY: SPONSOR_KEY, PIPER_DEPLOYMENT: deploymentFile,
      CHAIN_RPC_URL: RPC, MANAGE_KEY, PRIVY_APP_ID: "", ARKIV_PRIVATE_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  tracker.stdout.on("data", (b) => (out += b));
  tracker.stderr.on("data", (b) => (out += b));
  const peers = [];
  try {
    await until(() => out.includes("Tracker listening") && out.includes("market: answers cost"), 20000);
    const config = await (await fetch(`${server}/wallet/config`)).json();
    // 1.5 times SmolLM2's 0.1345 PIPER of rewards a token; the deployment opened at 0.2.
    check("/wallet/config gives PIPER (18 decimals, its EIP-712 domain), the market and the price the tracker set, and that asking is paid",
      config.payouts && config.token?.address === d.piper && config.token.symbol === "PIPER" && config.token.decimals === 18
      && config.token.version === "1" && config.token.chainId === CHAIN.id && config.market?.market === d.market
      && config.market.tokenPrice === "0.202" && config.paidAsks === true && out.includes("market: set the price"),
      `${config.token?.name} (${config.token?.symbol}), ${config.market?.tokenPrice} PIPER a token`);
    const price = BigInt(config.market.pricePerToken);

    const events = [];
    for (let i = 0; i < 3; i++) {
      const p = new Peer({ server, onEvent: (e) => events.push({ i, ...e }) });
      await p.connect();
      await p.load();
      peers.push(p);
    }
    const wallets = peers.map(() => privateKeyToAccount(generatePrivateKey()));
    const link = (i) => wallets[i].signMessage({ message: peers[i].walletChallenge })
      .then((signature) => peers[i].sendWallet({ type: "wallet", kind: "browser", address: wallets[i].address, signature }));
    const status = (i) => events.filter((e) => e.i === i && e.type === "wallet" && !e.error).at(-1);
    // The asker links first: asking is paid. The others link after serving.
    await link(0);
    await until(() => status(0)?.address === wallets[0].address);

    const asker = peers[0];
    await asker.loadTokenizer();
    const tok = asker.tokenizer;
    const pay = async (text, maxPayment) => {
      const promptHash = keccak256(toHex(text));
      const salt = randomBytes32();
      const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600);
      const signature = await wallets[0].signTypedData(receiveTypedData(config.market.piper, {
        from: wallets[0].address, to: d.market, value: maxPayment, validAfter: 0n, validBefore, nonce: queryId(wallets[0].address, promptHash, salt),
      }));
      return { maxPayment: String(maxPayment), validBefore: String(validBefore), promptHash, salt, signature };
    };
    const ask = async (text, maxPayment, maxNew) => {
      const ids = tok.chat([{ role: "user", content: text }]);
      const steps = [];
      try {
        for await (const step of asker.ask(ids, { maxNew, stopIds: tok.stopIds, payment: await pay(text, maxPayment) })) steps.push(step);
      } catch (err) {
        return { error: err.message, prompt: ids.length };
      }
      return { steps, prompt: ids.length, finish: steps.at(-1)?.finish };
    };
    const settled = () => events.filter((e) => e.i === 0 && e.type === "query" && e.state === "settled");

    const broke = await ask("Hello", PIPER(1), 8);
    check("a wallet without PIPER can't pay for a question", /payment refused: not enough/.test(broke.error ?? ""), broke.error);

    const post = (key, body) => fetch(`${server}/manage/faucet`, {
      method: "POST", headers: { "content-type": "application/json", "x-manage-key": key }, body: JSON.stringify(body),
    });
    check("the faucet refuses a wrong management key", (await post("nope", { peer: asker.id, piper: "30" })).status === 403);
    const faucet = await (await post(MANAGE_KEY, { peer: asker.id, piper: "30" })).json();
    await until(() => status(0)?.balance === String(PIPER(30)));
    check("the faucet sends the asker 30 PIPER from the treasury", !!faucet.piper && status(0)?.balance === String(PIPER(30)), faucet.error ?? faucet.piper);

    // 10 tokens' worth: less than the question itself.
    const tooLong = await ask("What is the capital of France?", price * 10n, 8);
    await until(() => settled().length === 1, 10000);
    check("a question longer than its payment covers isn't run, and is refunded in full",
      /raise the most/.test(tooLong.error ?? "") && settled()[0]?.cost === "0" && settled()[0]?.refund === String(price * 10n), tooLong.error);

    // 60 tokens' worth: the prompt, then answer tokens up to 60 in all.
    const story = await ask("Write a long story about a dragon who learns to fly.", price * 60n, 200);
    const n = story.steps?.length ?? 0;
    await until(() => settled().length === 2, 10000);
    const s2 = settled()[1];
    check("a long answer stops at the token limit it paid for", story.finish === "limit" && story.prompt + n - 1 === 60,
      `${story.prompt} prompt + ${n} answer tokens, ${story.error ?? story.finish}`);
    check("and is charged all of it, nothing refunded", s2?.tokens === 60 && s2.cost === String(price * 60n) && s2.refund === "0",
      s2 && `${s2.tokens} tokens, ${formatUnits(BigInt(s2.cost), 18)} PIPER`);

    const short = await ask("What is the capital of France?", price * 60n, 64);
    await until(() => settled().length === 3, 10000);
    const s3 = settled()[2];
    const ran = short.prompt + (short.steps?.length ?? 0) - 1;
    check("a short answer stops at the stop token and pays only for the tokens run",
      short.finish === "stop" && s3?.tokens === ran && s3.cost === String(price * BigInt(ran)) && BigInt(s3.refund) > 0n,
      s3 && `${ran} tokens: ${formatUnits(BigInt(s3.cost), 18)} PIPER, ${formatUnits(BigInt(s3.refund), 18)} back`);
    // The asker serves a block too, so payouts keep adding to what it holds.
    const spent = price * 60n + BigInt(s3?.cost ?? 0);
    const holds = async () => (await balanceOf(d.piper, wallets[0].address)) === PIPER(30) - spent + BigInt(status(0).paid);
    check("the asker holds 30 PIPER, less what it was charged, plus what it earned", await until(holds, 5000));

    // The other phones link after serving: what they earned before still counts.
    await link(1);
    await link(2);
    const servers = [1, 2];
    const earned = await until(() => servers.every((i) => status(i)?.address === wallets[i].address
      && BigInt(status(i).balance ?? 0) > 0n && status(i).pending === "0"), 20000);
    check("the phones that served are linked, paid, and told their balance", earned);
    const params = paramsModel(JSON.parse(readFileSync(join(WEIGHTS, "manifest.json"), "utf8")));
    const all = [0, 1, 2].map((i) => BigInt(status(i)?.params ?? 0));
    // Every phone ran the same tokens, so parameter-ops go by the block's parameters.
    const perParam = Number(all[1]) / params(peers[1].block);
    check("phones earn by their block's parameters",
      peers.every((p, i) => Math.abs(Number(all[i]) - perParam * params(p.block)) < 1),
      peers.map((p, i) => `${p.id} ${(params(p.block) / 1e6).toFixed(1)} M params: ${(Number(all[i]) / 1e9).toFixed(2)} B ops`).join(", "));

    // Phone 2 tops up test USDC and buys PIPER with it, all by signing.
    const replies = () => events.filter((e) => e.i === 2 && e.type === "walletReply");
    const request = async (msg) => {
      const count = replies().length;
      peers[2].sendWallet({ ...msg, requestId: count + 100 });
      await until(() => replies().length > count, 15000);
      return replies().at(-1);
    };
    const topup = await request({ type: "topup" });
    await until(() => status(2)?.usdc === String(parseUnits("100", 6)));
    check("a phone tops up 100 test USDC", !!topup.hash && status(2)?.usdc === String(parseUnits("100", 6)), topup.error ?? topup.hash);
    const amountIn = parseUnits("10", 6);
    const quote = await request({ type: "quote", side: "buy", amountIn: String(amountIn) });
    const piperBefore = BigInt(status(2).balance);
    const from = wallets[2].address;
    const minOut = (BigInt(quote.amountOut) * 99n) / 100n;
    const salt = randomBytes32();
    const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600);
    const zeroForOne = BigInt(d.usdc) < BigInt(d.piper);
    const sig = await wallets[2].signTypedData(receiveTypedData(config.market.usdc, {
      from, to: d.router, value: amountIn, validAfter: 0n, validBefore, nonce: swapNonce(from, zeroForOne, minOut, from, salt),
    }));
    const swapped = await request({ type: "swap", side: "buy", amountIn: String(amountIn), minOut: String(minOut), validBefore: String(validBefore), salt, signature: sig });
    await until(() => BigInt(status(2)?.balance ?? 0) > piperBefore);
    check("it buys PIPER with 10 USDC through the tracker, at the quoted price",
      !!swapped.hash && BigInt(status(2).balance) - piperBefore === BigInt(quote.amountOut) && status(2).usdc === String(parseUnits("90", 6)),
      swapped.error ?? `${formatUnits(BigInt(quote.amountOut), 18)} PIPER`);

    const dest = privateKeyToAccount(generatePrivateKey()).address;
    const balance = BigInt(status(2).balance);
    const a = { from, to: dest, value: balance, validAfter: 0n, validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600), nonce: `0x${newNonce()}${newNonce()}` };
    const signature = await wallets[2].signTypedData(transferTypedData(config.token, a));
    peers[2].sendWallet({ type: "withdraw", requestId: 1, ...a, value: String(a.value), validAfter: "0", validBefore: String(a.validBefore), signature });
    const done = await until(() => events.find((e) => e.i === 2 && e.type === "withdrawn"), 15000);
    const reply = events.find((e) => e.i === 2 && e.type === "withdrawn");
    check("a phone withdraws everything through the tracker", !!done && !!reply?.hash && (await balanceOf(d.piper, dest)) === balance, reply?.error ?? reply?.hash);
    check("none of these phones ever held ETH",
      (await Promise.all(wallets.map((w) => createPublicClient({ chain: CHAIN, transport: http(RPC) }).getBalance({ address: w.address })))).every((b) => b === 0n));
  } finally {
    for (const p of peers) p.close();
    tracker.kill();
  }
  if (results.includes(false)) console.log(out.split("\n").slice(-40).join("\n"));
}

const failed = results.filter((ok) => !ok).length;
console.log(failed ? `\n${failed} of ${results.length} checks failed` : `\nAll ${results.length} checks passed`);
process.exit(failed ? 1 : 0);

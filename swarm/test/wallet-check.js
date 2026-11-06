// Wallet and rewards checks.
//
//  1. A phone links its wallet by signing the tracker's challenge; a wrong
//     signer or another connection's challenge is refused.
//  2. Earnings: layer-tokens times the reward, kept in a ledger that
//     survives a restart.
// With a chain (an RPC whose chain id is Unichain Sepolia's 1301, e.g. a
// local Hardhat node started with chainId 1301):
//  3. Deploy PIPER USDC; a payout round pays everyone due in one transaction.
//  4. A round sent before a crash is settled on restart, never paid twice.
//  5. Withdrawing with a signed TransferWithAuthorization: it arrives; a
//     replay, a changed recipient, or someone else's wallet are refused.
//  6. The real tracker: three phones serve an answer, link wallets, get paid
//     and see it, and one withdraws.
//
//   node test/wallet-check.js [RPC_URL]
//   RPC_URL needs funded account 0 of the standard test mnemonic (Hardhat's).

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, parseUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { unichainSepolia } from "viem/chains";

import { deploy } from "../chain/deploy.js";
import { costModel } from "../src/blocks.js";
import { Peer } from "../src/peer.js";
import { createRewards, TOKEN_ABI } from "../src/rewards.js";
import { newNonce, verifyWallet, walletChallenge } from "../src/wallet-auth.js";
import { transferTypedData } from "../wallet/typed-data.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const RPC = process.argv[2] ?? null;
const TREASURY_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // Hardhat account 0

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
  const file = join(tmp, "ledger-2.json");
  const r = createRewards({ file, rewardPerLayerToken: "0.001", log: quiet });
  const a = privateKeyToAccount(generatePrivateKey()).address;
  r.credit(a, 8 * 15);    // 8 tokens through a 15-layer block
  r.credit(a, 1 * 15.5);  // fractional layer-equivalents count too
  const expected = parseUnits("0.1355", 6);
  check("8 tokens x 15 layers + 1 x 15.5 at 0.001 earns 0.1355", BigInt(r.status(a).pending) === expected, r.status(a).pending);
  r.flush();
  const again = createRewards({ file, log: quiet });
  check("the ledger survives a restart", BigInt(again.status(a).pending) === expected && again.status(a).layerTokens === 136);

  // One token at a time through the output block: 7.997 millionths of a
  // pUSDC each, less than a unit's worth of fraction lost per credit if dropped.
  const tiny = createRewards({ file: join(tmp, "ledger-2b.json"), rewardPerLayerToken: "0.000001", log: quiet });
  for (let i = 0; i < 1000; i++) tiny.credit(a, 7.997);
  check("fractions of a unit carry over: 1000 x 7.997 layer-tokens at 0.000001 pay 7997 units", tiny.status(a).pending === "7997",
    tiny.status(a).pending);

  writeFileSync(join(tmp, "ledger-18.json"), JSON.stringify({ accounts: { [a]: { pending: "1000000000000000000", paid: "0", layerTokens: 1000 } } }));
  const old = await refused((async () => createRewards({ file: join(tmp, "ledger-18.json"), log: quiet }))());
  check("a ledger kept in 18 decimals (the old PIPER) is refused, not read as pUSDC", /18 decimals/.test(old ?? ""), old);
}

if (!RPC) {
  console.log("(no RPC given: skipping the on-chain checks 3-6)");
} else {
  const transport = http(RPC);
  const pub = createPublicClient({ chain: unichainSepolia, transport });
  const balanceOf = (token, a) => pub.readContract({ address: token, abi: TOKEN_ABI, functionName: "balanceOf", args: [a] });

  console.log("3. Deploying and paying out");
  const d = await deploy({ privateKey: TREASURY_KEY, rpcUrl: RPC, supply: "1000000" });
  check("pUSDC deploys with the supply in the treasury", (await balanceOf(d.token, d.treasury)) === parseUnits("1000000", 6), d.token);
  const chain = { privateKey: TREASURY_KEY, rpcUrl: RPC, token: d.token };
  const file = join(tmp, "ledger-3.json");
  const r = createRewards({ file, rewardPerLayerToken: "0.001", payoutMin: "0.01", chain, withdrawEvery: 0, log: quiet });
  await r.init();
  const phones = [0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey()));
  r.credit(phones[0].address, 1000);  // 1 pUSDC
  r.credit(phones[1].address, 20);    // 0.02
  r.credit(phones[2].address, 5);     // 0.005: below the minimum, waits
  const before = await pub.getBlockNumber({ cacheTime: 0 });
  const paid = await r.payout();
  const after = await pub.getBlockNumber({ cacheTime: 0 });
  const balances = await Promise.all(phones.map((p) => balanceOf(d.token, p.address)));
  check("one transaction pays everyone above the minimum",
    paid.length === 2 && after === before + 1n && balances[0] === parseUnits("1", 6) && balances[1] === parseUnits("0.02", 6) && balances[2] === 0n,
    balances.map(String).join(", "));
  check("paid moves out of pending; below the minimum stays pending",
    r.status(phones[0].address).pending === "0" && r.status(phones[0].address).paid === String(parseUnits("1", 6))
    && r.status(phones[2].address).pending === String(parseUnits("0.005", 6)));
  check("the next round has nothing to pay", (await r.payout()).length === 0);

  console.log("4. A round in flight across a restart");
  {
    const crashFile = join(tmp, "ledger-4.json");
    const p = privateKeyToAccount(generatePrivateKey()).address;
    const amount = parseUnits("0.5", 6);
    // The treasury sent the round, then the tracker died before settling it.
    const treasury = createWalletClient({ account: privateKeyToAccount(TREASURY_KEY), chain: unichainSepolia, transport });
    const hash = await treasury.writeContract({ address: d.token, abi: TOKEN_ABI, functionName: "transferMany", args: [[p], [amount]] });
    writeFileSync(crashFile, JSON.stringify({
      decimals: 6,
      accounts: { [p]: { pending: String(amount), paid: "0", layerTokens: 500 } },
      inflight: { hash, amounts: { [p]: String(amount) } },
    }));
    const restarted = createRewards({ file: crashFile, chain, log: quiet });
    await restarted.init();
    const s = restarted.status(p);
    const ledger = JSON.parse(readFileSync(crashFile, "utf8"));
    check("on restart the round is settled from its receipt", s.pending === "0" && s.paid === String(amount) && ledger.inflight === null);
    check("and not paid again", (await restarted.payout()).length === 0 && (await balanceOf(d.token, p)) === amount);
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
    const a = auth(dest, parseUnits("0.4", 6));
    const signature = await phone.signTypedData(transferTypedData(token, a));
    const ethBefore = await pub.getBalance({ address: phone.address });
    const hash = await r.withdraw(phone.address, message(a, signature)).catch((err) => err.message);
    check("a signed withdrawal arrives, and the phone's wallet pays no gas",
      (await balanceOf(d.token, dest)) === parseUnits("0.4", 6) && (await pub.getBalance({ address: phone.address })) === ethBefore && ethBefore === 0n, hash);
    check("its balance is read again after", r.status(phone.address).balance === String(parseUnits("0.6", 6)));
    const replay = await refused(r.withdraw(phone.address, message(a, signature)));
    check("the same signature again is refused", /already sent/.test(replay ?? ""), replay);
    const b = auth(dest, parseUnits("0.1", 6));
    const sigB = await phone.signTypedData(transferTypedData(token, b));
    const redirected = await refused(r.withdraw(phone.address, message({ ...b, to: d.treasury }, sigB)));
    check("changing the recipient breaks the signature", /doesn't match/.test(redirected ?? ""), redirected);
    const notYours = await refused(r.withdraw(phones[1].address, message(b, sigB)));
    check("a phone can't withdraw from another phone's wallet", /only withdraw from this phone's wallet/.test(notYours ?? ""), notYours);
    const tooMuch = auth(dest, parseUnits("5", 6));
    const sigC = await phone.signTypedData(transferTypedData(token, tooMuch));
    const over = await refused(r.withdraw(phone.address, message(tooMuch, sigC)));
    check("more than the balance is refused before anything is sent", /not that much/.test(over ?? ""), over);
  }

  console.log("6. The tracker: serve, link, get paid, withdraw");
  await trackerCheck(d.token);
}

async function trackerCheck(token) {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const server = `http://localhost:${port}`;
  const ledger = join(tmp, "ledger-6.json");
  const tracker = spawn(process.execPath, [
    join(ROOT, "swarm", "tracker.js"), "--port", String(port), "--host", "127.0.0.1", "--min-replica", "1",
    "--payout-every", "1000", "--payout-min", "0.0001", "--reward", "0.001", "--ledger", ledger,
  ], { env: { ...process.env, TREASURY_PRIVATE_KEY: TREASURY_KEY, PIPER_TOKEN: token, CHAIN_RPC_URL: RPC, PRIVY_APP_ID: "", ARKIV_PRIVATE_KEY: "" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  tracker.stdout.on("data", (b) => (out += b));
  tracker.stderr.on("data", (b) => (out += b));
  const peers = [];
  try {
    await until(() => out.includes("Tracker listening"), 15000);
    const config = await (await fetch(`${server}/wallet/config`)).json();
    check("/wallet/config gives the token, PIPER USDC with USDC's 6 decimals, and its EIP-712 domain",
      config.payouts && config.token?.address.toLowerCase() === token.toLowerCase() && config.token.name === "PIPER USDC"
      && config.token.symbol === "pUSDC" && config.token.decimals === 6 && config.token.version === "1" && config.token.chainId === 1301,
      `${config.token?.name} (${config.token?.symbol}), ${config.token?.decimals} decimals`);

    const events = [];
    for (let i = 0; i < 3; i++) {
      const p = new Peer({ server, onEvent: (e) => events.push({ i, ...e }) });
      await p.connect();
      await p.load();
      peers.push(p);
    }
    // The asker links its wallet after serving starts: what it earned before still counts.
    await peers[0].loadTokenizer();
    const ids = peers[0].tokenizer.chat([{ role: "user", content: "What is the capital of France?" }]);
    let n = 0;
    for await (const _ of peers[0].ask(ids, { maxNew: 6, stopIds: peers[0].tokenizer.stopIds ?? [peers[0].tokenizer.eosId] })) n++;
    const wallets = peers.map(() => privateKeyToAccount(generatePrivateKey()));
    const signatures = [];
    for (const [i, p] of peers.entries()) {
      signatures[i] = await wallets[i].signMessage({ message: p.walletChallenge });
      p.sendWallet({ type: "wallet", kind: "browser", address: wallets[i].address, signature: signatures[i] });
    }
    const status = (i) => events.filter((e) => e.i === i && e.type === "wallet" && !e.error).at(-1);
    const linked = await until(() => peers.every((_, i) => status(i)?.address === wallets[i].address));
    check(`every phone that served ${n} tokens is linked and has earnings`, linked && peers.every((_, i) => BigInt(status(i).pending) + BigInt(status(i).paid) > 0n));

    // Phone B replays the signature phone A sent, to earn into A's wallet... or
    // to claim it as its own; either way it was signed for A's connection.
    peers[1].sendWallet({ type: "wallet", address: wallets[0].address, signature: signatures[0] });
    const refusedLink = await until(() => events.some((e) => e.i === 1 && e.type === "wallet" && e.error));
    check("a link signed for another connection is refused, and the phone keeps its wallet",
      refusedLink && status(1).address === wallets[1].address);

    const paid = await until(() => peers.every((_, i) => BigInt(status(i)?.balance ?? 0) > 0n && status(i).pending === "0"), 20000);
    const onChain = await Promise.all(wallets.map((w) => createPublicClient({ chain: unichainSepolia, transport: http(RPC) })
      .readContract({ address: token, abi: TOKEN_ABI, functionName: "balanceOf", args: [w.address] })));
    check("the payout round pays them, and each phone is told its balance",
      paid && onChain.every((b, i) => String(b) === status(i).balance), onChain.map(String).join(", "));
    // Every phone ran the same tokens, so earnings go by the block's layer-equivalents.
    const cost = costModel(JSON.parse(readFileSync(join(ROOT, "weights", "smollm2-135m-instruct", "manifest.json"), "utf8")));
    // A's block is whole layers, so its earnings are exact; the others may still carry under one unit.
    const a0 = peers.findIndex((p) => Number.isInteger(cost(p.block)));
    const perLayer = Number(onChain[a0]) / cost(peers[a0].block);
    check("phones earn by their block's compute", onChain.every((b, i) => Math.abs(Number(b) - perLayer * cost(peers[i].block)) < 1),
      peers.map((p, i) => `${p.id} ${cost(p.block).toFixed(2)} layers: ${Number(onChain[i]) / 1e6}`).join(", "));

    const dest = privateKeyToAccount(generatePrivateKey()).address;
    const balance = BigInt(status(2).balance);
    const a = { from: wallets[2].address, to: dest, value: balance, validAfter: 0n, validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600), nonce: `0x${newNonce()}${newNonce()}` };
    const signature = await wallets[2].signTypedData(transferTypedData(config.token, a));
    peers[2].sendWallet({ type: "withdraw", requestId: 1, ...a, value: String(a.value), validAfter: "0", validBefore: String(a.validBefore), signature });
    const done = await until(() => events.find((e) => e.i === 2 && e.type === "withdrawn"), 15000);
    const reply = events.find((e) => e.i === 2 && e.type === "withdrawn");
    const destBalance = await createPublicClient({ chain: unichainSepolia, transport: http(RPC) })
      .readContract({ address: token, abi: TOKEN_ABI, functionName: "balanceOf", args: [dest] });
    check("a phone withdraws everything through the tracker", !!done && !!reply?.hash && destBalance === balance, reply?.error ?? reply?.hash);
    await until(() => status(2)?.balance === "0" || BigInt(status(2)?.balance ?? 1) < balance);
    check("and is told its new balance", BigInt(status(2).balance) < balance);
  } finally {
    for (const p of peers) p.close();
    tracker.kill();
  }
  if (results.includes(false)) console.log(out.split("\n").slice(-30).join("\n"));
}

const failed = results.filter((ok) => !ok).length;
console.log(failed ? `\n${failed} of ${results.length} checks failed` : `\nAll ${results.length} checks passed`);
process.exit(failed ? 1 : 0);

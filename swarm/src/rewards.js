// What phones earn for the blocks they serve, and paying it out in PIPER on
// Unichain Sepolia (chain/PiedPiperToken.sol).
//
// Earnings are counted in layer-tokens: a phone that runs n tokens through a
// block of c layer-equivalents (blocks.js costModel) does n * c of them. They
// go to the phone's wallet address as pending; every payout round, the
// treasury sends everything pending above the minimum in one transferMany
// transaction. The ledger lives in a JSON file, so a restart loses nothing.
//
// A round's transaction is written to the ledger before it is waited on.
// Until it is settled, no other round starts; after a crash it is looked up
// again, so a round is never paid twice.
//
// Withdrawing: the phone's wallet holds PIPER but no ETH, so it signs an
// ERC-3009 TransferWithAuthorization to its own destination, and the
// treasury submits it and pays the gas.

import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createPublicClient, createWalletClient, formatUnits, getAddress, http, isAddress, isHex, parseAbi, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { unichainSepolia } from "viem/chains";

export const TOKEN_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
  "function authorizationState(address, bytes32) view returns (bool)",
  "function transferMany(address[] to, uint256[] amounts)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
  "error AuthorizationNotYetValid()",
  "error AuthorizationExpired()",
  "error AuthorizationAlreadyUsed()",
  "error InvalidAuthorizationSignature()",
  "error LengthMismatch()",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
]);

const WITHDRAW_ERRORS = {
  AuthorizationAlreadyUsed: "this withdrawal was already sent",
  AuthorizationExpired: "the signature expired; withdraw again",
  AuthorizationNotYetValid: "the signature isn't valid yet",
  InvalidAuthorizationSignature: "the signature doesn't match this withdrawal",
  ERC20InsufficientBalance: "not that much PIPER in this wallet",
};

const PER_ROUND = 200;          // recipients per transferMany
const SCALE = 1_000_000n;       // layer-tokens are fractional; count them in millionths

// chain: { privateKey, rpcUrl, token } to pay out, or null to only count.
// withdrawEvery: ms a wallet waits between withdrawals, since the treasury pays their gas.
export function createRewards({
  file, rewardPerLayerToken = "0.001", payoutMin = "0.01", chain = null, withdrawEvery = 30000, log = console.log,
}) {
  const reward = parseUnits(rewardPerLayerToken, 18);
  const ledger = load(file);
  const balances = new Map(); // address -> on-chain balance, as last read
  const lastWithdraw = new Map();
  let token = null;           // { address, name, symbol, decimals, version, chainId }
  let min = parseUnits(payoutMin, 18);
  let paying = false;
  let saveTimer = null;

  const account = chain ? privateKeyToAccount(chain.privateKey) : null;
  const transport = chain ? http(chain.rpcUrl) : null;
  const pub = chain ? createPublicClient({ chain: unichainSepolia, transport }) : null;
  const wallet = chain ? createWalletClient({ account, chain: unichainSepolia, transport }) : null;

  const entry = (address) => (ledger.accounts[address] ??= { pending: "0", paid: "0", layerTokens: 0 });

  function save(now = false) {
    clearTimeout(saveTimer);
    saveTimer = null;
    const write = () => {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(ledger, null, 1));
      renameSync(`${file}.tmp`, file);
    };
    if (now) write();
    else saveTimer = setTimeout(write, 2000);
  }

  // Reads the token's name, decimals and EIP-712 domain, and settles a round
  // left from before a restart.
  async function init() {
    if (!chain) return;
    const read = (functionName, args = []) => pub.readContract({ address: chain.token, abi: TOKEN_ABI, functionName, args });
    const [name, symbol, decimals, domain, chainId] = await Promise.all([
      read("name"), read("symbol"), read("decimals"), read("eip712Domain"), pub.getChainId(),
    ]);
    token = { address: getAddress(chain.token), name, symbol, decimals, version: domain[2], chainId };
    min = parseUnits(payoutMin, decimals);
    if (ledger.inflight) await settle();
  }

  function credit(address, layerTokens) {
    if (!(layerTokens > 0)) return;
    const e = entry(address);
    const amount = (BigInt(Math.round(layerTokens * Number(SCALE))) * reward) / SCALE;
    e.pending = String(BigInt(e.pending) + amount);
    e.layerTokens += layerTokens;
    save();
  }

  function status(address) {
    const e = ledger.accounts[address] ?? { pending: "0", paid: "0", layerTokens: 0 };
    return { address, pending: e.pending, paid: e.paid, balance: balances.get(address) ?? null, layerTokens: Math.round(e.layerTokens) };
  }

  async function refresh(address) {
    if (!token) return status(address);
    try {
      balances.set(address, String(await pub.readContract({ address: token.address, abi: TOKEN_ABI, functionName: "balanceOf", args: [address] })));
    } catch (err) {
      log(`reading the PIPER balance of ${address} failed: ${err.shortMessage ?? err.message}`);
    }
    return status(address);
  }

  // One payout round. Returns the addresses paid, or [] if nothing was due.
  async function payout() {
    if (!token || paying) return [];
    paying = true;
    try {
      if (ledger.inflight && !(await settle())) return [];
      const due = Object.entries(ledger.accounts)
        .filter(([, e]) => BigInt(e.pending) >= min)
        .sort((a, b) => (BigInt(b[1].pending) > BigInt(a[1].pending) ? 1 : -1))
        .slice(0, PER_ROUND);
      if (!due.length) return [];
      const to = due.map(([a]) => a);
      const amounts = due.map(([, e]) => BigInt(e.pending));
      const total = amounts.reduce((a, b) => a + b, 0n);
      const treasury = await pub.readContract({ address: token.address, abi: TOKEN_ABI, functionName: "balanceOf", args: [account.address] });
      if (treasury < total) {
        log(`payout skipped: the treasury ${account.address} has ${fmt(treasury)} ${token.symbol}, and ${fmt(total)} is due`);
        return [];
      }
      const hash = await wallet.writeContract({ address: token.address, abi: TOKEN_ABI, functionName: "transferMany", args: [to, amounts] });
      ledger.inflight = { hash, amounts: Object.fromEntries(due.map(([a], i) => [a, String(amounts[i])])) };
      save(true);
      log(`paying ${fmt(total)} ${token.symbol} to ${to.length} wallet${to.length > 1 ? "s" : ""}: tx ${hash}`);
      return (await settle()) ? to : [];
    } catch (err) {
      log(`payout failed: ${err.shortMessage ?? err.message}`);
      return [];
    } finally {
      paying = false;
    }
  }

  // Waits for the round in flight. On success its amounts move from pending
  // to paid; if it reverted they stay pending. Returns false if it is still
  // unknown (the RPC is down, or the transaction is not mined yet).
  async function settle() {
    const { hash, amounts } = ledger.inflight;
    let receipt;
    try {
      receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120000 });
    } catch (err) {
      log(`payout ${hash} not settled yet: ${err.shortMessage ?? err.message}`);
      return false;
    }
    if (receipt.status === "success") {
      for (const [address, amount] of Object.entries(amounts)) {
        const e = entry(address);
        e.pending = String(BigInt(e.pending) - BigInt(amount));
        e.paid = String(BigInt(e.paid) + BigInt(amount));
      }
    } else {
      log(`payout ${hash} reverted; its amounts stay pending`);
    }
    ledger.inflight = null;
    save(true);
    if (receipt.status === "success") await Promise.all(Object.keys(amounts).map(refresh));
    return receipt.status === "success";
  }

  // Submits a phone's signed TransferWithAuthorization. owner is the wallet
  // the phone proved it holds; the signature must be from it.
  async function withdraw(owner, w) {
    if (!token) throw new Error("payouts are off on this tracker");
    if (!isAddress(w?.to) || !isHex(w?.nonce) || w.nonce.length !== 66 || !isHex(w?.signature)) throw new Error("bad withdraw message");
    if (getAddress(w.from) !== owner) throw new Error("you can only withdraw from this phone's wallet");
    const value = BigInt(w.value);
    if (value <= 0n) throw new Error("nothing to withdraw");
    const since = Date.now() - (lastWithdraw.get(owner) ?? -Infinity);
    if (since < withdrawEvery) throw new Error(`one withdrawal every ${withdrawEvery / 1000} s; try again in ${Math.ceil((withdrawEvery - since) / 1000)} s`);
    lastWithdraw.set(owner, Date.now());
    const args = [owner, getAddress(w.to), value, BigInt(w.validAfter), BigInt(w.validBefore), w.nonce, w.signature];
    let request;
    try {
      ({ request } = await pub.simulateContract({ account, address: token.address, abi: TOKEN_ABI, functionName: "transferWithAuthorization", args }));
    } catch (err) {
      const reason = WITHDRAW_ERRORS[err.walk?.((e) => e.data?.errorName)?.data.errorName];
      throw reason ? new Error(reason) : err;
    }
    const hash = await wallet.writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`withdraw transaction ${hash} reverted`);
    log(`${owner} withdrew ${fmt(value)} ${token.symbol} to ${args[1]}: tx ${hash}`);
    await refresh(owner);
    return hash;
  }

  const fmt = (wei) => formatUnits(wei, token?.decimals ?? 18);

  function info() {
    return {
      payouts: !!token,
      token,
      treasury: account?.address ?? null,
      explorer: unichainSepolia.blockExplorers.default.url,
      rewardPerLayerToken,
      payoutMin,
    };
  }

  return { init, credit, status, refresh, payout, withdraw, info, flush: () => save(true) };
}

function load(file) {
  try {
    const ledger = JSON.parse(readFileSync(file, "utf8"));
    return { accounts: ledger.accounts ?? {}, inflight: ledger.inflight ?? null };
  } catch (err) {
    if (err.code !== "ENOENT") throw new Error(`cannot read the rewards ledger ${file}: ${err.message}`);
    return { accounts: {}, inflight: null };
  }
}

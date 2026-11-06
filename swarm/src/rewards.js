// What phones earn for the compute they lend, paid in PIPER on Sepolia
// (chain/PiedPiperToken.sol).
//
// Earnings are counted in parameter-ops: a phone that runs n tokens through
// a block of p parameters (blocks.js paramsModel) did n * p of them, and earns
// rewardPerUnit PIPER for every unitParams of them. They go to the phone's
// wallet address as pending, in base units; what is left over below a unit is
// carried to the next credit, so nothing is lost to rounding. Every payout
// round, the treasury sends everything pending above the minimum in one
// transferMany transaction. The ledger lives in a JSON file, so a restart
// loses nothing.
//
// A round's transaction is written to the ledger before it is waited on.
// Until it is settled, no other round starts; after a crash it is looked up
// again, so a round is never paid twice.
//
// Withdrawing: the phone's wallet holds PIPER but no ETH, so it signs an
// ERC-3009 TransferWithAuthorization to its own destination, and the gas
// sponsor (or else the treasury) submits it and pays the gas.

import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createPublicClient, createWalletClient, formatUnits, getAddress, http, isAddress, isHex, nonceManager, parseAbi, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN } from "./chain.js";

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

const PER_ROUND = 200; // recipients per transferMany

// chain: { privateKey, relayerKey?, rpcUrl, token } to pay out, or null to
// only count. privateKey is the treasury's; relayerKey the gas sponsor's.
// withdrawEvery: ms a wallet waits between withdrawals, since someone else pays their gas.
export function createRewards({
  file, rewardPerUnit = "1", unitParams = 1e9, payoutMin = "1", decimals = 18, chain = null, withdrawEvery = 30000, log = console.log,
}) {
  const reward = parseUnits(rewardPerUnit, decimals);
  const unit = BigInt(unitParams);
  const min = parseUnits(payoutMin, decimals);
  const ledger = load(file, { decimals, rate: `${rewardPerUnit}/${unitParams}` }, log);
  const balances = new Map(); // address -> on-chain balance, as last read
  const lastWithdraw = new Map();
  let token = null;           // { address, name, symbol, decimals, version, chainId }
  let paying = false;
  let saveTimer = null;

  const account = chain ? privateKeyToAccount(chain.privateKey, { nonceManager }) : null;
  const relayer = chain?.relayerKey ? privateKeyToAccount(chain.relayerKey, { nonceManager }) : account;
  const transport = chain ? http(chain.rpcUrl) : null;
  const pub = chain ? createPublicClient({ chain: CHAIN, transport }) : null;
  const wallet = chain ? createWalletClient({ account, chain: CHAIN, transport }) : null;
  const relay = chain ? createWalletClient({ account: relayer, chain: CHAIN, transport }) : null;

  // carry: parameter-ops times the reward, below one base unit's worth.
  const entry = (address) => (ledger.accounts[address] ??= { pending: "0", paid: "0", carry: "0", params: 0 });

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
    const [name, symbol, tokenDecimals, domain, chainId] = await Promise.all([
      read("name"), read("symbol"), read("decimals"), read("eip712Domain"), pub.getChainId(),
    ]);
    if (tokenDecimals !== decimals) throw new Error(`${symbol} has ${tokenDecimals} decimals; the ledger counts in ${decimals}`);
    token = { address: getAddress(chain.token), name, symbol, decimals, version: domain[2], chainId };
    if (ledger.inflight) await settle();
  }

  // params: parameter-ops, a whole number.
  function credit(address, params) {
    if (!(params > 0)) return;
    const e = entry(address);
    const owed = BigInt(e.carry) + BigInt(Math.round(params)) * reward;
    e.pending = String(BigInt(e.pending) + owed / unit);
    e.carry = String(owed % unit);
    e.params += Math.round(params);
    save();
  }

  function status(address) {
    const e = ledger.accounts[address] ?? { pending: "0", paid: "0", params: 0 };
    return { address, pending: e.pending, paid: e.paid, balance: balances.get(address) ?? null, params: e.params };
  }

  async function refresh(address) {
    if (!token) return status(address);
    try {
      balances.set(address, String(await pub.readContract({ address: token.address, abi: TOKEN_ABI, functionName: "balanceOf", args: [address] })));
    } catch (err) {
      log(`reading the ${token.symbol} balance of ${address} failed: ${err.shortMessage ?? err.message}`);
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
      ({ request } = await pub.simulateContract({ account: relayer, address: token.address, abi: TOKEN_ABI, functionName: "transferWithAuthorization", args }));
    } catch (err) {
      const reason = WITHDRAW_ERRORS[err.walk?.((e) => e.data?.errorName)?.data.errorName];
      throw reason ? new Error(reason) : err;
    }
    const hash = await relay.writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`withdraw transaction ${hash} reverted`);
    log(`${owner} withdrew ${fmt(value)} ${token.symbol} to ${args[1]}: tx ${hash}`);
    await refresh(owner);
    return hash;
  }

  const fmt = (units) => formatUnits(units, decimals);

  function info() {
    return {
      payouts: !!token,
      token,
      treasury: account?.address ?? null,
      explorer: CHAIN.blockExplorers.default.url,
      rewardPerUnit,
      unitParams,
      payoutMin,
    };
  }

  return { init, credit, status, refresh, payout, withdraw, info, flush: () => save(true) };
}

// A ledger kept in other units (the old 6-decimal pUSDC, or counted per
// layer) is moved aside, not misread; its numbers were never on-chain money.
function load(file, terms, log) {
  let ledger;
  try {
    ledger = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw new Error(`cannot read the rewards ledger ${file}: ${err.message}`);
    return { ...terms, accounts: {}, inflight: null };
  }
  if (ledger.decimals !== terms.decimals || ledger.rate !== terms.rate) {
    if (ledger.inflight) throw new Error(`the rewards ledger ${file} has a payout in flight under other terms; settle it first`);
    let old = `${file}.old`;
    for (let i = 2; existsSync(old); i++) old = `${file}.old${i}`;
    renameSync(file, old);
    log(`the rewards ledger ${file} counted ${ledger.rate ?? "per layer"} in ${ledger.decimals ?? 18} decimals; moved it to ${old} and started a new one`);
    return { ...terms, accounts: {}, inflight: null };
  }
  return { ...terms, accounts: ledger.accounts ?? {}, inflight: ledger.inflight ?? null };
}

// What the phone has earned, and withdrawing it. sign(typedData) -> signature
// comes from whichever wallet the phone has (main.jsx, privy.jsx).

import { useState, useSyncExternalStore } from "react";
import { formatUnits, getAddress, isAddress, parseUnits } from "viem";
import { transferTypedData } from "./typed-data.js";

export function Earnings({ ctx, address, sign, problem = null, account }) {
  const { config, store } = ctx;
  const { status, error } = useSyncExternalStore(store.subscribe, store.get);
  const token = config.token;
  const symbol = token?.symbol ?? "pUSDC";
  const decimals = token?.decimals ?? 6;
  const amount = (wei) => trim(formatUnits(BigInt(wei), decimals));
  const linked = !!(status?.address && address && getAddress(status.address) === getAddress(address));
  const balance = linked && status.balance != null ? BigInt(status.balance) : 0n;
  const pending = linked ? BigInt(status.pending) : 0n;

  return (
    <div>
      <div className="wallet-balance">
        <span className="wallet-amount">{amount(balance)}</span> {symbol}
        {pending > 0n && <span className="muted"> + {amount(pending)} on the way</span>}
      </div>
      <div className="note">
        {config.payouts
          ? `You earn ${config.reward} ${symbol} for every token you run through one layer. Earnings are paid every ${Math.round(config.payoutEvery / 1000)} s once they reach ${config.payoutMin} ${symbol}.`
          : `Earnings are counted, and paid once the tracker's treasury is set up (${config.payoutsOff}).`}
      </div>
      {address && (
        <div className="note">
          Wallet{" "}
          {token ? <a href={`${config.explorer}/address/${address}`} target="_blank" rel="noopener">{short(address)}</a> : short(address)}
          {" · "}
          <button className="linkish" onClick={() => navigator.clipboard?.writeText(address)}>copy address</button>
          {!linked && !error && " · linking…"}
        </div>
      )}
      {account}
      {(problem || error) && <div className="note bad">{problem ?? error}</div>}
      {config.payouts && linked && <Withdraw ctx={ctx} address={address} balance={balance} sign={sign} decimals={decimals} symbol={symbol} />}
    </div>
  );
}

function Withdraw({ ctx, address, balance, sign, decimals, symbol }) {
  const { config, store, send } = ctx;
  const [to, setTo] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const submit = async (ev) => {
    ev.preventDefault();
    setResult(null);
    let wei;
    try {
      if (!isAddress(to.trim())) throw new Error("enter the address of the wallet to send to");
      wei = value.trim() ? parseUnits(value.trim(), decimals) : balance;
      if (wei <= 0n) throw new Error("nothing to withdraw yet");
      if (wei > balance) throw new Error(`you have ${trim(formatUnits(balance, decimals))} ${symbol}`);
    } catch (err) {
      return setResult({ error: err.shortMessage ?? err.message });
    }
    setBusy(true);
    try {
      const auth = {
        from: getAddress(address),
        to: getAddress(to.trim()),
        value: wei,
        validAfter: 0n,
        validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
        nonce: randomNonce(),
      };
      const signature = await sign(transferTypedData(config.token, auth));
      const reply = await store.request(send, {
        type: "withdraw", ...auth, value: String(auth.value), validAfter: "0", validBefore: String(auth.validBefore), signature,
      });
      setResult(reply);
      if (reply.hash) setValue("");
    } catch (err) {
      setResult({ error: err.shortMessage ?? err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="wallet-withdraw" onSubmit={submit}>
      <input placeholder="Send to 0x…" value={to} onChange={(e) => setTo(e.target.value)} spellCheck={false} autoComplete="off" />
      <input placeholder={`all (${trim(formatUnits(balance, decimals))})`} value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" />
      <button disabled={busy || balance === 0n}>{busy ? "Sending…" : "Withdraw"}</button>
      {result?.hash && (
        <div className="note">Sent: <a href={`${config.explorer}/tx/${result.hash}`} target="_blank" rel="noopener">{short(result.hash)}</a></div>
      )}
      {result?.error && <div className="note bad">{result.error}</div>}
    </form>
  );
}

function randomNonce() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

const short = (hex) => `${hex.slice(0, 6)}…${hex.slice(-4)}`;

// At most 6 decimals (USDC's, so a phone's first cents show), no trailing zeros.
function trim(s) {
  const [whole, frac = ""] = s.split(".");
  const f = frac.slice(0, 6).replace(/0+$/, "");
  return f ? `${whole}.${f}` : whole;
}

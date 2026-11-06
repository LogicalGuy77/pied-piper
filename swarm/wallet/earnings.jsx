// The wallet card: what the phone holds and has earned, what asking costs,
// trading PIPER and USDC on the pool, and withdrawing. sign(typedData) ->
// signature comes from whichever wallet the phone has (main.jsx, privy.jsx).

import { useEffect, useState, useSyncExternalStore } from "react";
import { formatUnits, getAddress, isAddress, parseUnits } from "viem";
import { randomBytes32, receiveTypedData, swapNonce, transferTypedData } from "./typed-data.js";

export function Earnings({ ctx, address, sign, signQuietly, problem = null, account }) {
  const { config, store } = ctx;
  const { status, error } = useSyncExternalStore(store.subscribe, store.get);
  const token = config.token;
  const market = config.market;
  const linked = !!(status?.address && address && getAddress(status.address) === getAddress(address));
  const balance = linked && status.balance != null ? BigInt(status.balance) : 0n;
  const usdc = linked && status.usdc != null ? BigInt(status.usdc) : null;
  const pending = linked ? BigInt(status.pending) : 0n;

  // Asking pays with this wallet's signature.
  useEffect(() => {
    store.signer = linked ? { address: getAddress(address), sign, signQuietly } : null;
  }, [linked, address, sign, signQuietly]);

  const perToken = (Number(config.reward) * config.paramsPerToken) / config.rewardParams;
  return (
    <div>
      <div className="wallet-balance">
        <span className="wallet-amount">{piper(balance)}</span> PIPER
        {pending > 0n && <span className="muted"> + {piper(pending)} on the way</span>}
        {usdc != null && <span className="muted"> · {trim(formatUnits(usdc, 6))} USDC</span>}
      </div>
      <div className="note">
        You earn {config.reward} PIPER for every {billions(config.rewardParams)} parameter-ops you compute
        (one token through the whole model is {billions(config.paramsPerToken)}, {perToken.toFixed(3)} PIPER split across its blocks).{" "}
        {config.payouts
          ? `Paid every ${Math.round(config.payoutEvery / 1000)} s once it reaches ${config.payoutMin} PIPER.`
          : `Paid once the tracker's treasury is set up (${config.payoutsOff}).`}
      </div>
      {market && <Asking ctx={ctx} balance={balance} />}
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
      {market && linked && <Trade ctx={ctx} address={address} piperBalance={balance} usdcBalance={usdc ?? 0n} sign={sign} />}
      {config.payouts && linked && <Withdraw ctx={ctx} address={address} balance={balance} sign={sign} />}
    </div>
  );
}

// What an answer costs, the most one question may cost, and PIPER's price on the pool.
function Asking({ ctx, balance }) {
  const { config, store } = ctx;
  const maxSpend = useSyncExternalStore(store.subscribe, store.maxSpend);
  const price = BigInt(config.market.pricePerToken);
  const usdcPerPiper = usePoolPrice();
  let tokens = 0n;
  try {
    tokens = parseUnits(maxSpend || "0", 18) / price;
  } catch {}
  return (
    <div className="note">
      {config.paidAsks ? "Asking costs" : "Asking is free here; it would cost"} {piper(price)} PIPER a token, the question's and the answer's.
      {config.paidAsks && (
        <>
          {" "}At most{" "}
          <input className="wallet-spend" value={maxSpend} inputMode="decimal" onChange={(e) => store.setMaxSpend(e.target.value.trim())} />
          {" "}PIPER a question ({String(tokens)} tokens); the rest comes back.
          {balance < price && <span className="bad"> This wallet has no PIPER yet: buy some below.</span>}
        </>
      )}
      {usdcPerPiper != null && <> 1 PIPER is {usdcPerPiper.toPrecision(3)} USDC on the Uniswap pool.</>}
    </div>
  );
}

function usePoolPrice() {
  const [price, setPrice] = useState(null);
  useEffect(() => {
    const read = () => fetch("/market/status").then((r) => r.json()).then((s) => s.price != null && setPrice(s.price)).catch(() => {});
    read();
    const timer = setInterval(read, 15000);
    return () => clearInterval(timer);
  }, []);
  return price;
}

// Buying PIPER with USDC or selling it, on the PIPER/USDC v4 pool. One
// signature of the input token to the router; the tracker's gas sponsor
// submits it.
function Trade({ ctx, address, piperBalance, usdcBalance, sign }) {
  const { config, store, send } = ctx;
  const { piper: piperToken, usdc: usdcToken, router } = config.market;
  const [side, setSide] = useState("buy");
  const [value, setValue] = useState("");
  const [quote, setQuote] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [inToken, outToken] = side === "buy" ? [usdcToken, piperToken] : [piperToken, usdcToken];
  const have = side === "buy" ? usdcBalance : piperBalance;
  const poolPrice = usePoolPrice();

  let amountIn = null;
  try {
    amountIn = value.trim() ? parseUnits(value.trim(), inToken.decimals) : null;
  } catch {}

  useEffect(() => {
    setQuote(null);
    if (!amountIn || amountIn <= 0n) return;
    const timer = setTimeout(() => {
      store.request(send, { type: "quote", side, amountIn: String(amountIn) })
        .then((r) => setQuote(r.error ? { error: r.error } : { ...r, out: BigInt(r.amountOut), for: amountIn }));
    }, 300);
    return () => clearTimeout(timer);
  }, [side, String(amountIn)]);

  const submit = async (ev) => {
    ev.preventDefault();
    setResult(null);
    if (!amountIn || amountIn <= 0n) return setResult({ error: `enter how much ${inToken.symbol} to ${side === "buy" ? "spend" : "sell"}` });
    if (amountIn > have) return setResult({ error: `you have ${trim(formatUnits(have, inToken.decimals))} ${inToken.symbol}` });
    if (!quote?.out || quote.for !== amountIn) return setResult({ error: "waiting for a price" });
    setBusy(true);
    try {
      const from = getAddress(address);
      const minOut = (quote.out * 99n) / 100n; // 1% slippage
      const zeroForOne = (side === "sell") === (BigInt(piperToken.address) < BigInt(usdcToken.address));
      const salt = randomBytes32();
      const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600);
      const signature = await sign(receiveTypedData(inToken, {
        from, to: router, value: amountIn, validAfter: 0n, validBefore, nonce: swapNonce(from, zeroForOne, minOut, from, salt),
      }));
      const reply = await store.request(send, {
        type: "swap", side, amountIn: String(amountIn), minOut: String(minOut), validBefore: String(validBefore), salt, signature,
      });
      setResult(reply);
      if (reply.hash) setValue("");
    } catch (err) {
      setResult({ error: err.shortMessage ?? err.message });
    } finally {
      setBusy(false);
    }
  };

  const topUp = async () => {
    setResult(null);
    setResult(await store.request(send, { type: "topup" }));
  };

  return (
    <form className="wallet-withdraw" onSubmit={submit}>
      <select value={side} onChange={(e) => setSide(e.target.value)}>
        <option value="buy">Buy PIPER with USDC</option>
        <option value="sell">Sell PIPER for USDC</option>
      </select>
      <input placeholder={`${inToken.symbol} to ${side === "buy" ? "spend" : "sell"}`} value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" />
      <button disabled={busy || !quote?.out}>{busy ? "Swapping…" : side === "buy" ? "Buy" : "Sell"}</button>
      <div className="note">
        {poolPrice != null && <>Pool price: 1 PIPER = {poolPrice.toPrecision(4)} USDC (1 USDC ≈ {trim((1 / poolPrice).toFixed(2))} PIPER). </>}
        You have {trim(formatUnits(have, inToken.decimals))} {inToken.symbol}
        {have > 0n && <> · <button type="button" className="linkish" onClick={() => setValue(formatUnits(have, inToken.decimals))}>use all</button></>}
        {" · "}<a href="pool.html" target="_blank" rel="noopener">pool details</a>
      </div>
      {amountIn > 0n && !quote && <div className="note">Asking the pool…</div>}
      {quote?.out != null && (
        <div className="note">
          <b>You get {trim(formatUnits(quote.out, outToken.decimals))} {outToken.symbol}</b>
          {quote.rate != null && <>, at {quote.rate.toPrecision(4)} USDC per PIPER: {(100 * quote.cost).toFixed(2)}% {side === "buy" ? "above" : "below"} the pool price, fees included
            (the pool's 0.3%, 0.2% for the swarm's gas, and the price moving). </>}
          {quote.priceAfter != null && <>The price goes to {quote.priceAfter.toPrecision(4)} USDC. </>}
          At least {trim(formatUnits((quote.out * 99n) / 100n, outToken.decimals))} {outToken.symbol}, or the swap doesn't happen.
          {quote.cost > 0.05 && <span className="bad"> The pool is small, so this trade moves the price a lot; a smaller one gets closer to the pool price.</span>}
        </div>
      )}
      <div className="note">
        {quote?.error && <span className="bad">{quote.error} </span>}
        {usdcToken.test
          ? <button type="button" className="linkish" onClick={topUp}>Get 100 test USDC</button>
          : <a href="https://faucet.circle.com" target="_blank" rel="noopener">Get Sepolia USDC</a>}
      </div>
      {result?.hash && (
        <div className="note">Done: <a href={`${config.explorer}/tx/${result.hash}`} target="_blank" rel="noopener">{short(result.hash)}</a></div>
      )}
      {result?.error && <div className="note bad">{result.error}</div>}
    </form>
  );
}

function Withdraw({ ctx, address, balance, sign }) {
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
      wei = value.trim() ? parseUnits(value.trim(), 18) : balance;
      if (wei <= 0n) throw new Error("nothing to withdraw yet");
      if (wei > balance) throw new Error(`you have ${piper(balance)} PIPER`);
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
        nonce: randomBytes32(),
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
      <input placeholder="Send PIPER to 0x…" value={to} onChange={(e) => setTo(e.target.value)} spellCheck={false} autoComplete="off" />
      <input placeholder={`all (${piper(balance)})`} value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" />
      <button disabled={busy || balance === 0n}>{busy ? "Sending…" : "Withdraw"}</button>
      {result?.hash && (
        <div className="note">Sent: <a href={`${config.explorer}/tx/${result.hash}`} target="_blank" rel="noopener">{short(result.hash)}</a></div>
      )}
      {result?.error && <div className="note bad">{result.error}</div>}
    </form>
  );
}

const short = (hex) => `${hex.slice(0, 6)}…${hex.slice(-4)}`;
const piper = (units) => trim(formatUnits(units, 18));
const billions = (n) => (n >= 1e9 ? `${+(n / 1e9).toFixed(2)} billion` : `${+(n / 1e6).toFixed(1)} million`);

// At most 4 decimals, no trailing zeros.
function trim(s) {
  const [whole, frac = ""] = s.split(".");
  const f = frac.slice(0, 4).replace(/0+$/, "");
  return f ? `${whole}.${f}` : whole;
}

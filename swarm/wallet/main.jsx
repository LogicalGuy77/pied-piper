// The phone page's wallet card, bundled to swarm/web/dist/ by wallet/build.js
// (npm run build). app.js mounts it once the tracker welcomes the phone.
//
// Every phone gets a wallet without signing up:
//  - with a Privy app (PRIVY_APP_ID on the tracker), a Privy guest account
//    and its embedded wallet (privy.jsx);
//  - without one, a key kept in this browser's localStorage.
// Either way the wallet signs the tracker's challenge, so the tracker knows
// where this phone's earnings go. Everything else is one signature that the
// tracker's gas sponsor submits: withdrawing, swapping on the PIPER/USDC
// pool (earnings.jsx), and paying for a question (pay() below).

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { formatUnits, keccak256, parseUnits, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Earnings } from "./earnings.jsx";
import { queryId, randomBytes32, receiveTypedData } from "./typed-data.js";

const KEY_STORE = "pied-piper-wallet-key";
const MAX_SPEND_STORE = "pied-piper-max-spend";

// config: GET /wallet/config. challenge: the text to sign, from the tracker's
// welcome. send(msg): to the tracker. Returns { update(msg), pay(text) }:
// update takes the tracker's "wallet", "withdrawn" and "walletReply"
// messages; pay signs the payment for a question.
export async function mountWallet(el, { config, challenge, send }) {
  const store = createStore();
  const ctx = { config, challenge, send, store };
  let app;
  if (config.privyAppId) {
    const { PrivyApp } = await import("./privy.jsx");
    app = <PrivyApp ctx={ctx} />;
  } else {
    app = <BrowserWallet ctx={ctx} />;
  }
  createRoot(el).render(app);
  return { update: store.update, pay: (text) => pay(ctx, text) };
}

// A PIPER payment of at most the phone's max spend (or its balance, if
// less), to the market, for this prompt. Signed without a prompt: asking is
// the phone's consent, and the most it can cost is shown on the card.
async function pay({ config, store }, text) {
  const signer = store.signer;
  const { piper, market, pricePerToken } = config.market;
  if (!signer) throw new Error("the wallet isn't linked yet");
  const balance = BigInt(store.get().status?.balance ?? 0);
  const price = BigInt(pricePerToken);
  let max = parseUnits(store.maxSpend(), 18);
  if (balance < max) max = balance - (balance % price);
  if (max < price) {
    throw new Error(`asking costs ${formatUnits(price, 18)} PIPER a token and this wallet has ${formatUnits(balance, 18)}: buy some on the wallet card`);
  }
  const promptHash = keccak256(toHex(text));
  const salt = randomBytes32();
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600);
  const message = { from: signer.address, to: market, value: max, validAfter: 0n, validBefore, nonce: queryId(signer.address, promptHash, salt) };
  const signature = await signer.signQuietly(receiveTypedData(piper, message));
  return { maxPayment: String(max), validBefore: String(validBefore), promptHash, salt, signature };
}

function createStore() {
  let state = { status: null, error: null };
  const listeners = new Set();
  const waiting = new Map(); // request id -> resolve
  let nextId = 1;
  let maxSpend = localStorage.getItem(MAX_SPEND_STORE) ?? "20";
  const notify = () => {
    state = { ...state };
    for (const l of listeners) l();
  };
  return {
    signer: null, // { address, sign, signQuietly } of the linked wallet
    subscribe: (l) => (listeners.add(l), () => listeners.delete(l)),
    get: () => state,
    update(msg) {
      if (msg.type === "withdrawn" || msg.type === "walletReply") {
        waiting.get(msg.requestId)?.(msg);
        waiting.delete(msg.requestId);
        return;
      }
      state = msg.error ? { ...state, error: msg.error } : { ...state, status: msg, error: null };
      notify();
    },
    request(send, msg) {
      const requestId = nextId++;
      return new Promise((resolve) => {
        waiting.set(requestId, resolve);
        send({ ...msg, requestId });
      });
    },
    maxSpend: () => maxSpend,
    setMaxSpend(value) {
      maxSpend = value;
      localStorage.setItem(MAX_SPEND_STORE, value);
      notify();
    },
  };
}

// No Privy app: a key kept in this browser.
function BrowserWallet({ ctx }) {
  const [account] = useState(() => {
    let key = localStorage.getItem(KEY_STORE);
    if (!key) localStorage.setItem(KEY_STORE, (key = generatePrivateKey()));
    return privateKeyToAccount(key);
  });
  const [showKey, setShowKey] = useState(false);
  useEffect(() => {
    account.signMessage({ message: ctx.challenge })
      .then((signature) => ctx.send({ type: "wallet", kind: "browser", address: account.address, signature }));
  }, []);
  const sign = (td) => account.signTypedData(td);
  const note = (
    <div className="note">
      This wallet lives only in this browser.{" "}
      <button className="linkish" onClick={() => setShowKey(!showKey)}>{showKey ? "Hide" : "Back up"} its private key</button>
      {showKey && <code className="wallet-key">{localStorage.getItem(KEY_STORE)}</code>}
    </div>
  );
  return <Earnings ctx={ctx} address={account.address} sign={sign} signQuietly={sign} account={note} />;
}

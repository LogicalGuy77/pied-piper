// The phone page's wallet card, bundled to swarm/web/dist/ by wallet/build.js
// (npm run build). app.js mounts it once the tracker welcomes the phone.
//
// Every phone gets a wallet without signing up:
//  - with a Privy app (PRIVY_APP_ID on the tracker), a Privy guest account
//    and its embedded wallet (privy.jsx);
//  - without one, a key kept in this browser's localStorage.
// Either way the wallet signs the tracker's challenge, so the tracker knows
// where this phone's earnings go, and withdrawing is one signature: the
// tracker submits it and pays the gas (earnings.jsx).

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Earnings } from "./earnings.jsx";

const KEY_STORE = "pied-piper-wallet-key";

// config: GET /wallet/config. challenge: the text to sign, from the tracker's
// welcome. send(msg): to the tracker. Returns { update(msg) } for the
// tracker's "wallet" and "withdrawn" messages.
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
  return { update: store.update };
}

function createStore() {
  let state = { status: null, error: null };
  const listeners = new Set();
  const waiting = new Map(); // withdraw request id -> resolve
  let nextId = 1;
  return {
    subscribe: (l) => (listeners.add(l), () => listeners.delete(l)),
    get: () => state,
    update(msg) {
      if (msg.type === "withdrawn") {
        waiting.get(msg.requestId)?.(msg);
        waiting.delete(msg.requestId);
        return;
      }
      state = msg.error ? { ...state, error: msg.error } : { status: msg, error: null };
      for (const l of listeners) l();
    },
    request(send, msg) {
      const requestId = nextId++;
      return new Promise((resolve) => {
        waiting.set(requestId, resolve);
        send({ ...msg, requestId });
      });
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
  const note = (
    <div className="note">
      This wallet lives only in this browser.{" "}
      <button className="linkish" onClick={() => setShowKey(!showKey)}>{showKey ? "Hide" : "Back up"} its private key</button>
      {showKey && <code className="wallet-key">{localStorage.getItem(KEY_STORE)}</code>}
    </div>
  );
  return <Earnings ctx={ctx} address={account.address} sign={(td) => account.signTypedData(td)} account={note} />;
}

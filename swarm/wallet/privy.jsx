// The Privy wallet: a guest account and its embedded wallet, created on the
// first visit with no questions asked and kept on this device. Signing in
// with email or phone later upgrades the guest and keeps the same wallet.
// Loaded only when the tracker has a Privy app, since Privy is most of the
// bundle.

import {
  PrivyProvider, useCreateWallet, useGuestAccounts, usePrivy, useSignMessage, useSignTypedData,
} from "@privy-io/react-auth";
import { useEffect, useRef, useState } from "react";
import { unichainSepolia } from "viem/chains";
import { Earnings } from "./earnings.jsx";

export function PrivyApp({ ctx }) {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  return (
    <PrivyProvider
      appId={ctx.config.privyAppId}
      config={{
        loginMethods: ["email", "sms"],
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
        supportedChains: [unichainSepolia],
        defaultChain: unichainSepolia,
        appearance: { theme: dark ? "dark" : "light", accentColor: dark ? "#4fc3cd" : "#0b7a85" },
      }}
    >
      <PrivyWallet ctx={ctx} />
    </PrivyProvider>
  );
}

const embeddedAddress = (user) =>
  user?.linkedAccounts?.find((a) => a.type === "wallet" && a.walletClientType === "privy" && a.chainType !== "solana")?.address ?? null;

function PrivyWallet({ ctx }) {
  const { ready, authenticated, user, login, logout } = usePrivy();
  const { createGuestAccount } = useGuestAccounts();
  const { createWallet } = useCreateWallet();
  const { signMessage } = useSignMessage();
  const { signTypedData } = useSignTypedData();
  const [problem, setProblem] = useState(null);
  const tried = useRef({ guest: false, walletFor: null, linked: null });
  const address = embeddedAddress(user);

  // First visit: a guest account. After a sign-out the phone offers the
  // choice instead of making another guest.
  useEffect(() => {
    if (!ready || authenticated || tried.current.guest) return;
    tried.current.guest = true;
    createGuestAccount().catch((err) => setProblem(`Couldn't create a guest wallet: ${err.message}`));
  }, [ready, authenticated]);

  useEffect(() => {
    if (!ready || !authenticated || address || tried.current.walletFor === user?.id) return;
    tried.current.walletFor = user?.id;
    createWallet().catch((err) => setProblem(`Couldn't create a wallet: ${err.message}`));
  }, [ready, authenticated, address, user?.id]);

  // Tell the tracker where this phone's earnings go. The challenge is the
  // tracker's own text, so it is signed without a prompt.
  useEffect(() => {
    if (!address || tried.current.linked === address) return;
    tried.current.linked = address;
    signMessage({ message: ctx.challenge }, { uiOptions: { showWalletUIs: false }, address })
      .then(({ signature }) => ctx.send({ type: "wallet", kind: "privy", address, signature }))
      .catch((err) => setProblem(`Couldn't link the wallet: ${err.message}`));
  }, [address]);

  // Withdrawing does prompt: Privy shows what is being signed.
  const sign = async (typedData) => (await signTypedData(jsonSafe(typedData), { address })).signature;

  let account;
  if (!ready) {
    account = <div className="note">Starting the wallet…</div>;
  } else if (!authenticated) {
    account = (
      <div className="note">
        No wallet on this phone yet: what it earns is kept until it has one.{" "}
        <button className="linkish" onClick={() => createGuestAccount().catch((err) => setProblem(err.message))}>Continue as guest</button>
        {" or "}
        <button className="linkish" onClick={login}>sign in</button>
      </div>
    );
  } else if (user?.isGuest) {
    account = (
      <div className="note">
        Guest wallet, kept on this device for 30 days.{" "}
        <button className="linkish" onClick={login}>Sign in with email or phone</button> to keep it for good.
      </div>
    );
  } else {
    const who = user?.email?.address ?? user?.phone?.number ?? "your account";
    account = (
      <div className="note">
        Signed in as {who}. <button className="linkish" onClick={logout}>Sign out</button>
      </div>
    );
  }
  return <Earnings ctx={ctx} address={address} sign={sign} problem={problem} account={account} />;
}

// Privy hands typed data to its wallet as JSON, which has no bigints.
const jsonSafe = (td) => JSON.parse(JSON.stringify(td, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

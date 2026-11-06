// Which wallet a phone's earnings go to. The phone proves it holds it by
// signing walletChallenge() with it: a Privy embedded wallet signs without a
// prompt, a wallet kept in the browser signs locally. The challenge names this
// connection's nonce, so a signature can't be replayed on another connection.

import { randomBytes } from "node:crypto";
import { getAddress, isAddress, verifyMessage } from "viem";

export const newNonce = () => randomBytes(16).toString("hex");

export const walletChallenge = (peerId, nonce) =>
  `Pied Piper\n\nPay phone ${peerId} in this swarm for the compute it lends.\n\nNonce: ${nonce}`;

// { address, signature } -> the checksummed address; throws if unproven.
export async function verifyWallet(msg, { peerId, nonce }) {
  if (!isAddress(msg?.address ?? "") || typeof msg.signature !== "string") throw new Error("bad wallet message");
  const ok = await verifyMessage({ address: msg.address, message: walletChallenge(peerId, nonce), signature: msg.signature });
  if (!ok) throw new Error("the signature is not from that wallet");
  return getAddress(msg.address);
}

// What a phone's wallet signs, as the contracts in swarm/chain check it.
// token: { name, version, chainId, address } from the tracker's /wallet/config.

import { encodeAbiParameters, keccak256, toHex } from "viem";

const FIELDS = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
];

function authorization(primaryType, token, message) {
  return {
    domain: { name: token.name, version: token.version, chainId: token.chainId, verifyingContract: token.address },
    types: { [primaryType]: FIELDS },
    primaryType,
    message,
  };
}

// ERC-3009, GaslessERC20.sol. message: { from, to, value, validAfter, validBefore, nonce }.
// A transfer anyone may submit (withdrawals); a receive only `to` may (payments to a contract).
export const transferTypedData = (token, message) => authorization("TransferWithAuthorization", token, message);
export const receiveTypedData = (token, message) => authorization("ReceiveWithAuthorization", token, message);

// InferenceMarket.queryId: the nonce of a question's payment.
export const queryId = (asker, promptHash, salt) =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }, { type: "bytes32" }], [asker, promptHash, salt]));

// PiperRouter.swapNonce: the nonce of a swap's payment.
export const swapNonce = (from, zeroForOne, minOut, to, salt) =>
  keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "bool" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }],
    [from, zeroForOne, minOut, to, salt],
  ));

export const randomBytes32 = () => toHex(crypto.getRandomValues(new Uint8Array(32)));

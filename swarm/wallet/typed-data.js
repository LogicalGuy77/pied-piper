// ERC-3009 TransferWithAuthorization, as chain/PiedPiperToken.sol checks it.
// token: the tracker's /wallet/config token. message: { from, to, value,
// validAfter, validBefore, nonce }.
export function transferTypedData(token, message) {
  return {
    domain: { name: token.name, version: token.version, chainId: token.chainId, verifyingContract: token.address },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message,
  };
}

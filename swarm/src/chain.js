// The chain PIPER lives on: Ethereum Sepolia. CHAIN_RPC_URL in swarm/.env
// overrides the RPC; the default is a public node.

import { sepolia } from "viem/chains";

export const CHAIN = { ...sepolia, rpcUrls: { default: { http: ["https://ethereum-sepolia-rpc.publicnode.com"] } } };

// Uniswap v4 on Sepolia (docs.uniswap.org/contracts/v4/deployments).
export const POOL_MANAGER = "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543";

// Circle's USDC on Sepolia (faucet.circle.com): ERC-3009, so swaps need no ETH.
export const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {GaslessERC20} from "./GaslessERC20.sol";

/// A stand-in for USDC on the testnet, with USDC's 6 decimals: the other
/// side of the PIPER/USDC pool. Anyone may mint some, as from a faucet.
contract TestUSDC is GaslessERC20 {
    uint256 public constant MINT_LIMIT = 10_000e6;

    error MintLimit();

    constructor() GaslessERC20("Test USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        if (amount > MINT_LIMIT) revert MintLimit();
        _mint(to, amount);
    }
}

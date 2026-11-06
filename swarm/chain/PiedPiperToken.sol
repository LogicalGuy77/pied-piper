// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {GaslessERC20} from "./GaslessERC20.sol";

/// PIPER: the swarm's inference token. Phones earn it for the compute they
/// lend, askers spend it on answers (InferenceMarket.sol), and its price
/// floats in the PIPER/USDC Uniswap v4 pool, so the market sets what
/// inference costs. The whole supply is minted once, to the treasury.
contract PiedPiperToken is GaslessERC20 {
    constructor(address treasury, uint256 supply) GaslessERC20("Pied Piper", "PIPER") {
        _mint(treasury, supply);
    }
}

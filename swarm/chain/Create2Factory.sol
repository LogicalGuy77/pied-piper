// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// Deploys code at an address known in advance, so chain/deploy.js can mine a
/// salt that puts GasSponsorHook at an address with its v4 flag bits.
contract Create2Factory {
    event Deployed(address addr, bytes32 salt);

    error DeployFailed();

    function deploy(bytes32 salt, bytes calldata code) external returns (address addr) {
        bytes memory initCode = code;
        assembly {
            addr := create2(0, add(initCode, 0x20), mload(initCode), salt)
        }
        if (addr == address(0)) revert DeployFailed();
        emit Deployed(addr, salt);
    }
}

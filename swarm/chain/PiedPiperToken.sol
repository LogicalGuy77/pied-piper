// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// Pied Piper's compute token. The whole supply is minted once, to the
/// treasury that pays phones for the blocks they serve.
///
/// On top of ERC-20 and EIP-2612 permit it has ERC-3009's
/// transferWithAuthorization: a phone's wallet holds no ETH, so it withdraws
/// by signing, and the tracker submits the signature and pays the gas. The
/// signature names the recipient, so whoever submits it can't redirect the
/// tokens. transferMany pays a whole payout round in one transaction.
contract PiedPiperToken is ERC20, ERC20Permit {
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    mapping(address authorizer => mapping(bytes32 nonce => bool used)) public authorizationState;

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error AuthorizationAlreadyUsed();
    error InvalidAuthorizationSignature();
    error LengthMismatch();

    constructor(address treasury, uint256 supply)
        ERC20("Pied Piper Compute", "PIPER")
        ERC20Permit("Pied Piper Compute")
    {
        _mint(treasury, supply);
    }

    function transferMany(address[] calldata to, uint256[] calldata amounts) external {
        if (to.length != amounts.length) revert LengthMismatch();
        for (uint256 i = 0; i < to.length; i++) {
            _transfer(msg.sender, to[i], amounts[i]);
        }
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (authorizationState[from][nonce]) revert AuthorizationAlreadyUsed();
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce))
        );
        if (!SignatureChecker.isValidSignatureNow(from, digest, signature)) revert InvalidAuthorizationSignature();
        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }
}

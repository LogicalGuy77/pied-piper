// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {GaslessERC20} from "./GaslessERC20.sol";

/// Trades on the PIPER/USDC v4 pool for wallets that hold no ETH, and the
/// owner's (treasury's) liquidity.
///
/// swapWithAuthorization: the swapper signs a ReceiveWithAuthorization of the
/// input token to this router, with the nonce swapNonce(...), which fixes the
/// direction, the least output it accepts and where the output goes. Anyone
/// may submit it (the tracker's gas sponsor does). swap() is the same for a
/// wallet with ETH that approved the router. quote() runs a swap and reverts
/// with its output, for eth_call.
contract PiperRouter is IUnlockCallback, Ownable {
    using SafeERC20 for IERC20;
    using BalanceDeltaLibrary for BalanceDelta;

    enum Action { Swap, Quote, Liquidity }

    IPoolManager public immutable poolManager;
    Currency public immutable currency0;
    Currency public immutable currency1;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    IHooks public immutable hooks;

    event Swapped(address indexed payer, address indexed to, bool zeroForOne, uint256 amountIn, uint256 amountOut);

    error NotPoolManager();
    error TooLittleReceived(uint256 amountOut, uint256 minOut);
    error Quote(uint256 amountOut);

    constructor(IPoolManager poolManager_, PoolKey memory key, address owner_) Ownable(owner_) {
        poolManager = poolManager_;
        currency0 = key.currency0;
        currency1 = key.currency1;
        fee = key.fee;
        tickSpacing = key.tickSpacing;
        hooks = key.hooks;
    }

    function poolKey() public view returns (PoolKey memory) {
        return PoolKey(currency0, currency1, fee, tickSpacing, hooks);
    }

    function swapNonce(address from, bool zeroForOne, uint256 minOut, address to, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(from, zeroForOne, minOut, to, salt));
    }

    function swapWithAuthorization(
        address from,
        bool zeroForOne,
        uint256 amountIn,
        uint256 minOut,
        address to,
        uint256 validBefore,
        bytes32 salt,
        bytes calldata signature
    ) external returns (uint256 amountOut) {
        GaslessERC20 tokenIn = GaslessERC20(Currency.unwrap(zeroForOne ? currency0 : currency1));
        bytes32 nonce = swapNonce(from, zeroForOne, minOut, to, salt);
        tokenIn.receiveWithAuthorization(from, address(this), amountIn, 0, validBefore, nonce, signature);
        amountOut = _swap(from, zeroForOne, amountIn, minOut, to);
    }

    function swap(bool zeroForOne, uint256 amountIn, uint256 minOut, address to) external returns (uint256 amountOut) {
        IERC20(Currency.unwrap(zeroForOne ? currency0 : currency1)).safeTransferFrom(msg.sender, address(this), amountIn);
        amountOut = _swap(msg.sender, zeroForOne, amountIn, minOut, to);
    }

    /// Not a view: call it with eth_call. Reverts with Quote(amountOut).
    function quote(bool zeroForOne, uint256 amountIn) external {
        poolManager.unlock(abi.encode(Action.Quote, abi.encode(zeroForOne, amountIn)));
    }

    /// Adds (liquidity > 0) or removes (< 0) the owner's full-range position,
    /// paying from or to the owner, who approves this router for both tokens.
    function modifyLiquidity(int256 liquidity) external onlyOwner returns (BalanceDelta delta) {
        delta = abi.decode(poolManager.unlock(abi.encode(Action.Liquidity, abi.encode(liquidity))), (BalanceDelta));
    }

    function fullRange() public view returns (int24 lower, int24 upper) {
        upper = (TickMath.MAX_TICK / tickSpacing) * tickSpacing;
        lower = -upper;
    }

    // The router holds amountIn; what the pool doesn't take goes back to the payer.
    function _swap(address payer, bool zeroForOne, uint256 amountIn, uint256 minOut, address to)
        private
        returns (uint256 amountOut)
    {
        (uint256 paid, uint256 out) = abi.decode(
            poolManager.unlock(abi.encode(Action.Swap, abi.encode(zeroForOne, amountIn, to))), (uint256, uint256)
        );
        if (out < minOut) revert TooLittleReceived(out, minOut);
        if (paid < amountIn) {
            IERC20(Currency.unwrap(zeroForOne ? currency0 : currency1)).safeTransfer(payer, amountIn - paid);
        }
        emit Swapped(payer, to, zeroForOne, paid, out);
        return out;
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (Action action, bytes memory data) = abi.decode(raw, (Action, bytes));
        if (action == Action.Liquidity) return _liquidity(abi.decode(data, (int256)));

        bool zeroForOne;
        uint256 amountIn;
        address to;
        if (action == Action.Quote) (zeroForOne, amountIn) = abi.decode(data, (bool, uint256));
        else (zeroForOne, amountIn, to) = abi.decode(data, (bool, uint256, address));

        BalanceDelta delta = poolManager.swap(
            poolKey(),
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        (int128 inDelta, int128 outDelta) = zeroForOne ? (delta.amount0(), delta.amount1()) : (delta.amount1(), delta.amount0());
        uint256 paid = uint256(uint128(-inDelta));
        uint256 out = uint256(uint128(outDelta));
        if (action == Action.Quote) revert Quote(out);

        (Currency cIn, Currency cOut) = zeroForOne ? (currency0, currency1) : (currency1, currency0);
        _pay(cIn, address(this), paid);
        if (out > 0) poolManager.take(cOut, to, out);
        return abi.encode(paid, out);
    }

    function _liquidity(int256 liquidity) private returns (bytes memory) {
        (int24 lower, int24 upper) = fullRange();
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            poolKey(), ModifyLiquidityParams({tickLower: lower, tickUpper: upper, liquidityDelta: liquidity, salt: 0}), ""
        );
        _settle(currency0, delta.amount0());
        _settle(currency1, delta.amount1());
        return abi.encode(delta);
    }

    function _settle(Currency currency, int128 amount) private {
        if (amount < 0) _pay(currency, owner(), uint256(uint128(-amount)));
        else if (amount > 0) poolManager.take(currency, owner(), uint256(uint128(amount)));
    }

    function _pay(Currency currency, address from, uint256 amount) private {
        if (amount == 0) return;
        poolManager.sync(currency);
        IERC20 token = IERC20(Currency.unwrap(currency));
        if (from == address(this)) token.safeTransfer(address(poolManager), amount);
        else token.safeTransferFrom(from, address(poolManager), amount);
        poolManager.settle();
    }
}

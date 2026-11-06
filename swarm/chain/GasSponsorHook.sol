// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";
import {BaseTestHooks} from "@uniswap/v4-core/src/test/BaseTestHooks.sol";
import {BalanceDelta, BalanceDeltaLibrary, toBalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// The PIPER/USDC pool's hook: a cut of every swap and every liquidity
/// deposit goes to the gas sponsor, the wallet that pays the gas for askers'
/// queries, phones' withdrawals and gasless swaps. Trading inference tokens
/// pays for the swarm's transactions.
///
/// The cut is taken on top of the pool's LP fee, with v4's return deltas: on
/// a swap, SWAP_FEE_BIPS of the side the swapper didn't fix (the output of an
/// exact-input swap, the input of an exact-output one); on a deposit,
/// DEPOSIT_FEE_BIPS of each token deposited. A swap's cut goes straight to
/// the sponsor; a deposit's waits as claims until collect().
///
/// v4 reads a hook's callbacks from its address, so this must be deployed at
/// an address whose low 14 bits are exactly FLAGS (chain/deploy.js mines a
/// CREATE2 salt for it).
contract GasSponsorHook is BaseTestHooks, IUnlockCallback, Ownable {
    using SafeCast for uint256;
    using BalanceDeltaLibrary for BalanceDelta;
    using CurrencyLibrary for Currency;

    uint160 public constant FLAGS = Hooks.AFTER_ADD_LIQUIDITY_FLAG | Hooks.AFTER_SWAP_FLAG
        | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG;
    uint256 public constant SWAP_FEE_BIPS = 20; // 0.2%
    uint256 public constant DEPOSIT_FEE_BIPS = 10; // 0.1%
    uint256 private constant TOTAL_BIPS = 10_000;

    IPoolManager public immutable poolManager;
    address public sponsor;

    event SponsorFee(Currency indexed currency, uint256 amount, bool swap);
    event SponsorSet(address sponsor);

    error NotPoolManager();

    constructor(IPoolManager poolManager_, address sponsor_, address owner_) Ownable(owner_) {
        poolManager = poolManager_;
        sponsor = sponsor_;
        Hooks.validateHookPermissions(
            IHooks(address(this)),
            Hooks.Permissions({
                beforeInitialize: false,
                afterInitialize: false,
                beforeAddLiquidity: false,
                afterAddLiquidity: true,
                beforeRemoveLiquidity: false,
                afterRemoveLiquidity: false,
                beforeSwap: false,
                afterSwap: true,
                beforeDonate: false,
                afterDonate: false,
                beforeSwapReturnDelta: false,
                afterSwapReturnDelta: true,
                afterAddLiquidityReturnDelta: true,
                afterRemoveLiquidityReturnDelta: false
            })
        );
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    function setSponsor(address sponsor_) external onlyOwner {
        sponsor = sponsor_;
        emit SponsorSet(sponsor_);
    }

    function afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        external
        override
        onlyPoolManager
        returns (bytes4, int128)
    {
        bool specifiedIs0 = (params.amountSpecified < 0 == params.zeroForOne);
        (Currency currency, int128 amount) = specifiedIs0 ? (key.currency1, delta.amount1()) : (key.currency0, delta.amount0());
        if (amount < 0) amount = -amount;
        uint256 fee = uint128(amount) * SWAP_FEE_BIPS / TOTAL_BIPS;
        if (fee > 0) {
            poolManager.take(currency, sponsor, fee);
            emit SponsorFee(currency, fee, true);
        }
        return (IHooks.afterSwap.selector, fee.toInt128());
    }

    /// delta includes the position's accrued LP fees; only what was put in pays.
    function afterAddLiquidity(
        address,
        PoolKey calldata key,
        ModifyLiquidityParams calldata,
        BalanceDelta delta,
        BalanceDelta feesAccrued,
        bytes calldata
    ) external override onlyPoolManager returns (bytes4, BalanceDelta) {
        uint256 fee0 = _depositFee(key.currency0, delta.amount0() - feesAccrued.amount0());
        uint256 fee1 = _depositFee(key.currency1, delta.amount1() - feesAccrued.amount1());
        return (IHooks.afterAddLiquidity.selector, toBalanceDelta(fee0.toInt128(), fee1.toInt128()));
    }

    // The deposit hasn't been paid in yet when this runs, so the PoolManager
    // may not hold the tokens to pay the cut out: it is kept as the
    // PoolManager's ERC-6909 claims, which collect() turns into tokens.
    function _depositFee(Currency currency, int128 principal) private returns (uint256 fee) {
        if (principal >= 0) return 0;
        fee = uint128(-principal) * DEPOSIT_FEE_BIPS / TOTAL_BIPS;
        if (fee > 0) {
            poolManager.mint(address(this), currency.toId(), fee);
            emit SponsorFee(currency, fee, false);
        }
    }

    /// Sends the deposit cuts kept as claims to the sponsor. Anyone may call it.
    function collect(Currency currency) external returns (uint256 amount) {
        amount = poolManager.balanceOf(address(this), currency.toId());
        if (amount > 0) poolManager.unlock(abi.encode(currency, amount));
    }

    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        (Currency currency, uint256 amount) = abi.decode(data, (Currency, uint256));
        poolManager.burn(address(this), currency.toId(), amount);
        poolManager.take(currency, sponsor, amount);
        return "";
    }
}

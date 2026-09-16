// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";

/// Graduation hook callback, implemented by ArcodianLaunchFactoryV15.
interface IArcodianGraduation {
    function onSwap(PoolKey calldata key) external;
}

/// @notice Launch fee hook for V15 pools: 1% of every swap in USDC, plus the
/// trigger for graduation.
///
/// Identical to the V14 hook in how the trade fee is taken (see
/// ArcodianLaunchHookV14: always in USDC, exact-in and exact-out alike,
/// factory-only pools). One addition: after every swap on a pool that has not
/// graduated yet it asks the factory whether that swap carried the pool past
/// the 12,000 USDC graduation line, so graduation happens inside the trade
/// that reaches it — the way the V11 curve graduated — rather than waiting for
/// someone to call a function. Once a pool graduates the hook stops asking.
///
/// The one-time 1% graduation fee is recorded here too, as a USDC claim for
/// the treasury, so a single claim() withdraws both kinds of fee.
contract ArcodianLaunchHookV15 is IHooks, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;

    uint256 public constant TRADE_FEE_BPS = 100;
    uint256 public constant CREATOR_FEE_BPS = 50;

    IPoolManager public immutable poolManager;
    address payable public immutable treasury;
    /// The currency every fee is taken in (native USDC's ERC-20 view on Arc).
    Currency public immutable quote;
    address private immutable admin;
    address public factory;

    mapping(PoolId => address) public creatorOf;
    mapping(address => mapping(Currency => uint256)) public claimable;
    /// Set by the factory when a pool graduates; the hook stops calling it.
    mapping(PoolId => bool) public graduated;

    event LaunchRegistered(PoolId indexed poolId, address indexed creator);
    event FeeTaken(PoolId indexed poolId, Currency currency, uint256 creatorAmount, uint256 treasuryAmount);
    event Claimed(address indexed account, Currency currency, uint256 amount);
    event GraduationFeeRecorded(PoolId indexed poolId, uint256 quoteAmount);

    error NotPoolManager();
    error NotFactory();
    error FactoryAlreadySet();
    error NotDeployer();
    error AlreadyRegistered();
    error NothingToClaim();
    error NotAQuotePool();

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    /// @param admin_ allowed to call setFactory once. Explicit because the
    /// hook is deployed through the CREATE2 deployer (its address carries its
    /// permissions), so msg.sender here is that deployer, not a person.
    constructor(IPoolManager poolManager_, address admin_, address payable treasury_, Currency quote_) {
        require(
            address(poolManager_) != address(0) && admin_ != address(0) && treasury_ != address(0) && !quote_.isAddressZero(),
            "ZERO"
        );
        poolManager = poolManager_;
        admin = admin_;
        treasury = treasury_;
        quote = quote_;
    }

    /// @notice Bind the factory, once. The admin holds no power after this.
    function setFactory(address factory_) external {
        if (msg.sender != admin) revert NotDeployer();
        if (factory != address(0)) revert FactoryAlreadySet();
        require(factory_ != address(0), "ZERO_FACTORY");
        factory = factory_;
    }

    /// @notice Binds a pool to its creator, once, from the factory only.
    function registerLaunch(PoolId poolId, address creator) external {
        if (msg.sender != factory) revert NotFactory();
        if (creatorOf[poolId] != address(0)) revert AlreadyRegistered();
        require(creator != address(0), "ZERO_CREATOR");
        creatorOf[poolId] = creator;
        emit LaunchRegistered(poolId, creator);
    }

    /// @notice Books the one-time graduation fee the factory just minted to
    /// this hook as claims, and marks the pool graduated.
    function recordGraduation(PoolId poolId, uint256 quoteAmount) external {
        if (msg.sender != factory) revert NotFactory();
        graduated[poolId] = true;
        claimable[treasury][quote] += quoteAmount;
        emit GraduationFeeRecorded(poolId, quoteAmount);
    }

    /// @inheritdoc IHooks
    /// @dev Pools on this hook exist only because the factory made them, and
    /// every one of them is quoted in `quote` — which the fee logic relies on.
    function beforeInitialize(address sender, PoolKey calldata key, uint160) external view onlyPoolManager returns (bytes4) {
        if (sender != factory) revert NotFactory();
        if (!(key.currency0 == quote) && !(key.currency1 == quote)) revert NotAQuotePool();
        return IHooks.beforeInitialize.selector;
    }

    /// @inheritdoc IHooks
    function beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        // The specified currency is the input for an exact-in swap and the
        // output for an exact-out one.
        bool exactIn = params.amountSpecified < 0;
        Currency specified = (exactIn == params.zeroForOne) ? key.currency0 : key.currency1;
        if (!(specified == quote)) return (IHooks.beforeSwap.selector, toBeforeSwapDelta(0, 0), 0);

        uint256 amount = exactIn ? uint256(-params.amountSpecified) : uint256(params.amountSpecified);
        uint256 fee = _take(key, amount);
        // Positive specified delta, both cases. Exact-in: the pool swaps
        // amount - fee. Exact-out: the pool pays amount + fee and the trader
        // still receives exactly `amount`.
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(int128(int256(fee)), 0), 0);
    }

    /// @inheritdoc IHooks
    function afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, int128)
    {
        bool specifiedIsZero = (params.amountSpecified < 0) == params.zeroForOne;
        Currency unspecified = specifiedIsZero ? key.currency1 : key.currency0;
        uint256 fee;
        if (unspecified == quote) {
            int128 moved = specifiedIsZero ? delta.amount1() : delta.amount0();
            fee = _take(key, moved < 0 ? uint256(uint128(-moved)) : uint256(uint128(moved)));
        }
        // Graduation check on every swap until the pool graduates. The price
        // this swap produced is already written, so the factory reads the
        // post-trade state.
        if (!graduated[key.toId()]) IArcodianGraduation(factory).onSwap(key);
        // Positive unspecified delta: a seller receives `amount - fee`, an
        // exact-out buyer pays `amount + fee`.
        return (IHooks.afterSwap.selector, int128(int256(fee)));
    }

    /// Mints the fee to this hook as ERC-6909 claims and books the split.
    function _take(PoolKey calldata key, uint256 amount) private returns (uint256 fee) {
        fee = (amount * TRADE_FEE_BPS) / 10_000;
        if (fee == 0) return 0;
        poolManager.mint(address(this), quote.toId(), fee);

        PoolId poolId = key.toId();
        address creator = creatorOf[poolId];
        uint256 creatorCut = creator == address(0) ? 0 : fee / 2;
        uint256 treasuryCut = fee - creatorCut;
        if (creatorCut != 0) claimable[creator][quote] += creatorCut;
        claimable[treasury][quote] += treasuryCut;
        emit FeeTaken(poolId, quote, creatorCut, treasuryCut);
    }

    /// @notice Withdraw everything owed to the caller in `currency`.
    function claim(Currency currency) external {
        uint256 amount = claimable[msg.sender][currency];
        if (amount == 0) revert NothingToClaim();
        claimable[msg.sender][currency] = 0;
        poolManager.unlock(abi.encode(currency, msg.sender, amount));
        emit Claimed(msg.sender, currency, amount);
    }

    /// @inheritdoc IUnlockCallback
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (Currency currency, address recipient, uint256 amount) = abi.decode(data, (Currency, address, uint256));
        poolManager.burn(address(this), currency.toId(), amount);
        poolManager.take(currency, recipient, amount);
        return "";
    }

    // --- entry points not enabled in this hook's address flags ------------

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) { revert NotPoolManager(); }
    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata) external pure returns (bytes4) { revert NotPoolManager(); }
    function afterAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata) external pure returns (bytes4, BalanceDelta) { revert NotPoolManager(); }
    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata) external pure returns (bytes4) { revert NotPoolManager(); }
    function afterRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata) external pure returns (bytes4, BalanceDelta) { revert NotPoolManager(); }
    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) { revert NotPoolManager(); }
    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) { revert NotPoolManager(); }
}

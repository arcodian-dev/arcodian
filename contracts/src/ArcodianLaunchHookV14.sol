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

/// @notice Launch fee hook for V14 pools: 1% of every swap, always in USDC.
///
/// What changed from the V13 hook, and why:
///
/// 1. The fee is taken in the QUOTE, whichever way the trade goes. V13 cut
///    its 1% from the swap's input, so every sell paid the creator and the
///    treasury in the launched token — a balance that is worth least exactly
///    when people are selling. Here a buy pays from the USDC going in and a
///    sell pays from the USDC coming out.
///
/// 2. Exact-output swaps pay too. V13 let them through untouched, which made
///    the fee optional for any router that chose to quote by output.
///
///    Where the fee comes from depends on which side of the swap the USDC is:
///    - USDC is the SPECIFIED amount (exact-in buy, exact-out sell): taken in
///      beforeSwap, by returning a specified delta. For an exact-in buy the
///      pool swaps the input less the fee; for an exact-out sell the pool
///      pays out the requested amount plus the fee and the hook keeps the fee.
///    - USDC is the UNSPECIFIED amount (exact-in sell, exact-out buy): taken
///      in afterSwap, once the swap has fixed how much USDC moved. A seller
///      receives that amount less the fee; a buyer pays it plus the fee.
///
/// 3. Only the factory can create a pool on this hook. V13 accepted any
///    initialize(), so anyone could open a look-alike pool that carried our
///    hook's address and our fee.
///
/// Unchanged: 1% total, half to the launch's creator and half to the
/// treasury, pull-claimed, and the fee is minted as ERC-6909 claims during the
/// swap (a take() there underflows on a fresh pool) and redeemed in claim().
contract ArcodianLaunchHookV14 is IHooks, IUnlockCallback {
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

    event LaunchRegistered(PoolId indexed poolId, address indexed creator);
    event FeeTaken(PoolId indexed poolId, Currency currency, uint256 creatorAmount, uint256 treasuryAmount);
    event Claimed(address indexed account, Currency currency, uint256 amount);

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
        if (!(unspecified == quote)) return (IHooks.afterSwap.selector, 0);

        int128 moved = specifiedIsZero ? delta.amount1() : delta.amount0();
        uint256 amount = moved < 0 ? uint256(uint128(-moved)) : uint256(uint128(moved));
        uint256 fee = _take(key, amount);
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

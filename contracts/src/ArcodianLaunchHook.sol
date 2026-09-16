// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {CurrencyLibrary} from "v4-core/src/types/Currency.sol";

/// @notice The fee mechanism for Arcodian launches that trade in an open
/// Uniswap V4 pool.
///
/// Why this contract exists at all. Arcodian's bonding-curve engines charge
/// 1% per trade because every trade goes through the curve, which is code we
/// control. The moment a coin trades in an ordinary pool, anyone can swap it
/// without touching anything of ours — a router, an aggregator, a Telegram
/// buy bot — and a curve-shaped fee simply cannot reach them. That is the
/// real reason our launches were invisible to external bots: keeping the fee
/// meant keeping the curve, and keeping the curve meant there was no pool for
/// anyone to index.
///
/// A V4 hook resolves that. The pool is an ordinary Uniswap V4 pool that any
/// router can trade, and the hook is called by the PoolManager on every swap
/// through it, whoever initiated it. So the 1% survives contact with the open
/// market, and the coin is indexable from the moment it launches.
///
/// Fee terms are deliberately unchanged from the curve engines: 1% per trade,
/// split evenly between the launch's creator and the protocol treasury, both
/// pull-claimed. A V3 pool could not have done this — its fee goes to
/// liquidity providers, and fee-on-transfer tokens, the usual workaround, are
/// not tradeable on V3 at all.
contract ArcodianLaunchHook is IHooks, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;

    /// Total per-trade fee, in basis points. Matches the curve engines.
    uint256 public constant TRADE_FEE_BPS = 100;
    /// The creator's half. The treasury takes the remainder, so the two
    /// always sum to exactly TRADE_FEE_BPS with no rounding dust dropped.
    uint256 public constant CREATOR_FEE_BPS = 50;

    IPoolManager public immutable poolManager;
    address payable public immutable treasury;
    /// The factory allowed to bind creators. Not immutable because the
    /// factory needs the hook's address in its own constructor and the hook
    /// needs the factory's — one of them has to be set second. Settable
    /// exactly once, by the deployer, and only before any launch exists.
    address public factory;
    /// The account allowed to bind the factory, once.
    address private immutable admin;

    /// The creator entitled to a pool's creator share. Set once, by the
    /// factory, when the launch is created.
    mapping(PoolId => address) public creatorOf;
    /// Pull-claimable balances, per account, per currency.
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

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    /// @param admin_ the account allowed to call setFactory. Passed in
    /// rather than taken from msg.sender because this contract is deployed
    /// through the deterministic CREATE2 deployer — its address has to encode
    /// the hook's permissions, which means mining a salt, which means the
    /// constructor's msg.sender is that deployer contract and not a person.
    constructor(IPoolManager poolManager_, address admin_, address payable treasury_) {
        require(address(poolManager_) != address(0) && admin_ != address(0) && treasury_ != address(0), "ZERO");
        poolManager = poolManager_;
        treasury = treasury_;
        admin = admin_;
    }

    /// @notice Bind the factory, once.
    /// @dev Self-locking: after this the admin has no remaining privilege
    /// over the hook at all. A factory that could be changed later would let
    /// whoever changed it register pools and take the creator share.
    function setFactory(address factory_) external {
        if (msg.sender != admin) revert NotDeployer();
        if (factory != address(0)) revert FactoryAlreadySet();
        require(factory_ != address(0), "ZERO_FACTORY");
        factory = factory_;
    }

    /// @notice Binds a pool to the creator who launched it.
    /// @dev Only the factory, and only once — a pool whose creator could be
    /// reassigned would let whoever reassigned it collect the creator's half.
    function registerLaunch(PoolId poolId, address creator) external {
        if (msg.sender != factory) revert NotFactory();
        if (creatorOf[poolId] != address(0)) revert AlreadyRegistered();
        require(creator != address(0), "ZERO_CREATOR");
        creatorOf[poolId] = creator;
        emit LaunchRegistered(poolId, creator);
    }

    // --- the fee itself ----------------------------------------------------

    /// @inheritdoc IHooks
    /// @dev Takes TRADE_FEE_BPS of the swap's specified amount in the input
    /// currency and hands the pool back a matching delta, so the swap
    /// proceeds on the remainder. The PoolManager calls this for every swap
    /// through the pool regardless of who initiated it, which is the whole
    /// point — an external router's swap pays the same fee as one from
    /// arcodian.fun.
    function beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        // Only exact-input swaps carry a specified amount we can take a cut
        // of before the swap runs. An exact-output swap is left alone rather
        // than guessed at; charging an amount the trader did not specify is
        // how a hook ends up quietly breaking routers.
        int256 specified = params.amountSpecified;
        if (specified >= 0) return (IHooks.beforeSwap.selector, toBeforeSwapDelta(0, 0), 0);

        uint256 amountIn = uint256(-specified);
        uint256 fee = (amountIn * TRADE_FEE_BPS) / 10_000;
        if (fee == 0) return (IHooks.beforeSwap.selector, toBeforeSwapDelta(0, 0), 0);

        Currency input = params.zeroForOne ? key.currency0 : key.currency1;
        // Mint ERC-6909 claims rather than take() the real token.
        //
        // beforeSwap runs before the trader has settled anything, so on a
        // fresh launch the PoolManager holds none of the input currency yet
        // and take() underflows — which is exactly what the first version of
        // this did, and it failed on the very first buy. mint() is pure
        // accounting against the swap's own delta, so it works whatever the
        // manager's balance happens to be at that instant. The claims are
        // redeemed for the real token in claim() below.
        poolManager.mint(address(this), input.toId(), fee);

        PoolId poolId = key.toId();
        uint256 creatorCut = (amountIn * CREATOR_FEE_BPS) / 10_000;
        uint256 treasuryCut = fee - creatorCut;
        address creator = creatorOf[poolId];
        // A pool the factory never registered has no creator to pay; the
        // whole fee goes to the treasury rather than being stranded.
        if (creator == address(0)) {
            claimable[treasury][input] += fee;
            treasuryCut = fee;
            creatorCut = 0;
        } else {
            claimable[creator][input] += creatorCut;
            claimable[treasury][input] += treasuryCut;
        }
        emit FeeTaken(poolId, input, creatorCut, treasuryCut);

        // Positive specified delta: the pool swaps amountIn - fee.
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(int128(int256(fee)), 0), 0);
    }

    /// @notice Withdraw everything owed to the caller in `currency`.
    /// @dev Pull, never push: a transfer inside beforeSwap would put an
    /// arbitrary recipient in the middle of every swap.
    function claim(Currency currency) external {
        uint256 amount = claimable[msg.sender][currency];
        if (amount == 0) revert NothingToClaim();
        claimable[msg.sender][currency] = 0;
        // Redeeming ERC-6909 claims for the real token needs the manager
        // unlocked, so the withdrawal goes through unlockCallback.
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

    // --- unused hook entry points -----------------------------------------
    // Present because IHooks requires them. None is enabled in this hook's
    // address flags, so the PoolManager never calls them; each reverts rather
    // than silently accepting a call that should be impossible.

    function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) { revert NotPoolManager(); }
    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) { revert NotPoolManager(); }
    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata) external pure returns (bytes4) { revert NotPoolManager(); }
    function afterAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata) external pure returns (bytes4, BalanceDelta) { revert NotPoolManager(); }
    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata) external pure returns (bytes4) { revert NotPoolManager(); }
    function afterRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata) external pure returns (bytes4, BalanceDelta) { revert NotPoolManager(); }
    function afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata) external pure returns (bytes4, int128) { revert NotPoolManager(); }
    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) { revert NotPoolManager(); }
    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) { revert NotPoolManager(); }
}

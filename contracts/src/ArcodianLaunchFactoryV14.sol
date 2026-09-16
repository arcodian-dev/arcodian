// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PumpToken} from "./ArcPump.sol";
import {ArcodianLaunchHookV14} from "./ArcodianLaunchHookV14.sol";

/// @notice Launches a coin straight into a tradeable Uniswap V4 pool — V14.
///
/// Same launch as V13: fixed 1B supply, 1% of it to the treasury, the other
/// 99% single-sided in a V4 pool from ~$4,995 FDV, liquidity owned by this
/// contract with no code path that removes it. What changed:
///
/// - The pool's LP fee tier is 0. V13 pools sat in the 0.30% tier, and that
///   0.30% accrued to a position nobody can ever collect from — traders paid
///   1.30% and 0.30% of it went nowhere. A trade now costs exactly the hook's
///   1%, which the V14 hook takes in USDC (see ArcodianLaunchHookV14).
///
/// - The creator can buy at launch, in the same transaction (`initialBuy`).
///   A single-sided pool holds no USDC until somebody buys, and external
///   scanners report liquidity from the USDC actually in the pool — so every
///   untraded launch read as "$0 liquidity". There is no such thing as
///   virtual liquidity to a scanner. A launch buy puts real USDC in the pool
///   from the first block, and it cannot be sniped ahead of the creator
///   because the pool does not exist until this transaction creates it.
///   It goes through the pool like any other buy and pays the same 1%.
contract ArcodianLaunchFactoryV14 is IUnlockCallback {
    using PoolIdLibrary for PoolKey;

    uint8 public constant ENGINE_VERSION = 14;
    /// One-time fee on the launch itself, charged in the token's own supply
    /// and sent to the treasury. The per-trade 1% lives in the hook.
    uint256 public constant LAUNCH_FEE_BPS = 100;
    /// Fee tier and spacing of the pool that gets opened. Zero LP fee: the
    /// hook's 1% is the whole cost of a trade.
    uint24 public constant POOL_FEE = 0;
    int24 public constant TICK_SPACING = 60;
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    IPoolManager public immutable poolManager;
    ArcodianLaunchHookV14 public immutable hook;
    Currency public immutable quote;
    address payable public immutable treasury;

    uint256 public launchCount;
    mapping(uint256 => address) public tokenByLaunch;
    mapping(uint256 => PoolId) public poolByLaunch;
    mapping(address => PoolId) public poolForToken;
    mapping(address => bool) public isLaunch;

    event LaunchCreated(uint256 indexed id, address indexed creator, address token, PoolId poolId, uint256 tokenLiquidity, uint256 launchFee);
    event InitialBuy(uint256 indexed id, address indexed creator, uint256 quoteIn, uint256 tokensOut);

    error NotPoolManager();
    error BadMetadata();
    error TooLittleReceived(uint256 received, uint256 minimum);
    error TransferFailed();

    struct SeedData {
        PoolKey key;
        address token;
        uint256 amount;
        int24 tickLower;
        int24 tickUpper;
        address buyer;
        uint256 initialBuy;
        uint256 minTokensOut;
    }

    constructor(IPoolManager poolManager_, ArcodianLaunchHookV14 hook_, Currency quote_, address payable treasury_) {
        require(address(poolManager_) != address(0) && address(hook_) != address(0) && treasury_ != address(0), "ZERO");
        require(address(hook_.poolManager()) == address(poolManager_), "HOOK_MANAGER_MISMATCH");
        require(hook_.quote() == quote_, "HOOK_QUOTE_MISMATCH");
        // The hook cannot already name this factory: the hook needs to exist
        // before the factory can be constructed, so the binding is made
        // afterwards with setFactory. It is not left unchecked — the hook
        // rejects registerLaunch from anyone but its factory, so a mis-wired
        // pair cannot create a single launch, and wiringOk() below lets the
        // deploy script assert it rather than discovering it on first use.
        poolManager = poolManager_;
        hook = hook_;
        quote = quote_;
        treasury = treasury_;
    }

    /// @notice True once the hook has been pointed back at this factory.
    /// @dev Asserted by the deploy script. Without the binding, createLaunch
    /// reverts at registerLaunch rather than producing an unregistered pool.
    function wiringOk() external view returns (bool) {
        return hook.factory() == address(this);
    }

    /// @param initialBuy quote (USDC, 6 decimals) the creator spends buying
    /// at the launch price, 0 for none. Needs an ERC-20 approval of this
    /// factory for that amount.
    /// @param minTokensOut slippage floor for the launch buy; ignored when
    /// initialBuy is 0.
    function createLaunch(
        string calldata name,
        string calldata symbol,
        string calldata imageURI,
        uint256 initialBuy,
        uint256 minTokensOut
    ) external returns (address tokenAddress, PoolId poolId, uint256 tokensBought) {
        if (bytes(name).length > 40 || bytes(symbol).length < 2 || bytes(symbol).length > 10 || bytes(imageURI).length > 200) revert BadMetadata();

        PumpToken token = new PumpToken(name, symbol, imageURI, address(this));
        tokenAddress = address(token);
        uint256 supply = token.totalSupply();

        // The one-time fee comes out of supply before anything is priced, so
        // it is paid by the launch rather than by whoever happens to trade
        // first — the same principle as the curve engines' graduation fee.
        uint256 launchFee = (supply * LAUNCH_FEE_BPS) / 10_000;
        require(token.transfer(treasury, launchFee), "FEE_TRANSFER");
        uint256 seedAmount = supply - launchFee;

        Currency tokenCurrency = Currency.wrap(tokenAddress);
        bool tokenIsZero = tokenAddress < Currency.unwrap(quote);
        PoolKey memory key = PoolKey({
            currency0: tokenIsZero ? tokenCurrency : quote,
            currency1: tokenIsZero ? quote : tokenCurrency,
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });

        // Single-sided liquidity only works if the starting price sits at the
        // edge of the range: all of one asset, none of the other. The token
        // therefore starts at the extreme where it is worth the least, and
        // the range runs the whole way to the other extreme.
        (int24 tickLower, int24 tickUpper, int24 startTick) = _range(tokenIsZero);
        poolManager.initialize(key, TickMath.getSqrtPriceAtTick(startTick));

        // Registered before the seed/buy unlock so the launch buy's fee
        // already credits the creator's half.
        poolId = key.toId();
        hook.registerLaunch(poolId, msg.sender);

        bytes memory result = poolManager.unlock(abi.encode(SeedData({
            key: key, token: tokenAddress, amount: seedAmount, tickLower: tickLower, tickUpper: tickUpper,
            buyer: msg.sender, initialBuy: initialBuy, minTokensOut: minTokensOut
        })));
        tokensBought = abi.decode(result, (uint256));

        uint256 id = ++launchCount;
        tokenByLaunch[id] = tokenAddress;
        poolByLaunch[id] = poolId;
        poolForToken[tokenAddress] = poolId;
        isLaunch[tokenAddress] = true;
        emit LaunchCreated(id, msg.sender, tokenAddress, poolId, seedAmount, launchFee);
        if (initialBuy != 0) emit InitialBuy(id, msg.sender, initialBuy, tokensBought);
    }

    /// Launch price, as a tick, for each ordering of the pair.
    ///
    /// V12 started the pool at the extreme usable tick. That satisfies
    /// "single-sided" — but at that tick the token is priced at effectively
    /// zero, so the first buy of ANY size takes the entire supply: a 0.1 USDC
    /// quote on the live ArcBee V2 pool returned 989,999,999 of its
    /// 990,000,000 tokens. It was caught by quoting before the first trade.
    ///
    /// ±398,400 prices a token at ~0.000005 USDC, a ~$4,995 launch FDV — the
    /// same starting point the curve engines' virtual reserve gave. From
    /// there 1 USDC buys ~200,000 tokens and doubling the price takes ~$2,050
    /// of buying, which is the shape a launch should have. The sign flips
    /// with the pair's ordering because V4 prices currency1 in currency0:
    /// with the token as currency1 a cheap token is a HIGH tick.
    /// Both assume an 18-decimal token and a 6-decimal quote.
    int24 public constant LAUNCH_TICK_TOKEN0 = -398_400;
    int24 public constant LAUNCH_TICK_TOKEN1 = 398_400;

    /// Range for a single-sided token position starting at the launch price.
    ///
    /// A position holds only currency0 while the price sits at or below its
    /// lower tick, and only currency1 at or above its upper tick. So a token
    /// that is currency0 starts at the LOWER edge and the range runs up to the
    /// maximum; a token that is currency1 starts at the UPPER edge and the
    /// range runs down to the minimum. Either way buyers push the price
    /// through the range and the quote side fills up behind them.
    function _range(bool tokenIsZero) private pure returns (int24 lower, int24 upper, int24 start) {
        int24 min = (TickMath.MIN_TICK / TICK_SPACING + 1) * TICK_SPACING;
        int24 max = (TickMath.MAX_TICK / TICK_SPACING) * TICK_SPACING;
        if (tokenIsZero) {
            lower = LAUNCH_TICK_TOKEN0;
            upper = max;
            start = LAUNCH_TICK_TOKEN0;
        } else {
            lower = min;
            upper = LAUNCH_TICK_TOKEN1;
            start = LAUNCH_TICK_TOKEN1;
        }
    }

    /// @inheritdoc IUnlockCallback
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        SeedData memory seed = abi.decode(data, (SeedData));

        uint128 liquidity = _singleSidedLiquidity(seed);
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            seed.key,
            ModifyLiquidityParams({ tickLower: seed.tickLower, tickUpper: seed.tickUpper, liquidityDelta: int256(uint256(liquidity)), salt: 0 }),
            ""
        );

        // Pay whatever the pool asks for. A correct single-sided position
        // owes the token and nothing else; settling both sides anyway means a
        // rounding wei on the quote side cannot strand the launch.
        _settle(seed.key.currency0, delta.amount0());
        _settle(seed.key.currency1, delta.amount1());

        if (seed.initialBuy == 0) return abi.encode(uint256(0));

        // The launch buy: exact-in, quote for token, through the hook.
        bool zeroForOne = !(seed.token == Currency.unwrap(seed.key.currency0));
        BalanceDelta swapDelta = poolManager.swap(
            seed.key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(seed.initialBuy),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        int128 paidDelta = zeroForOne ? swapDelta.amount0() : swapDelta.amount1();
        int128 outDelta = zeroForOne ? swapDelta.amount1() : swapDelta.amount0();
        uint256 paid = uint256(uint128(-paidDelta));
        uint256 bought = uint256(uint128(outDelta));
        if (bought < seed.minTokensOut) revert TooLittleReceived(bought, seed.minTokensOut);

        poolManager.sync(quote);
        (bool ok, bytes memory ret) = Currency.unwrap(quote).call(
            abi.encodeWithSelector(0x23b872dd, seed.buyer, address(poolManager), paid)
        );
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
        poolManager.settle();
        poolManager.take(Currency.wrap(seed.token), seed.buyer, bought);
        return abi.encode(bought);
    }

    function _settle(Currency currency, int128 amount) private {
        if (amount >= 0) return;
        uint256 owed = uint256(uint128(-amount));
        poolManager.sync(currency);
        currency.transfer(address(poolManager), owed);
        poolManager.settle();
    }

    /// Liquidity that a token-only position of `amount` supports over the range.
    function _singleSidedLiquidity(SeedData memory seed) private pure returns (uint128) {
        uint160 lower = TickMath.getSqrtPriceAtTick(seed.tickLower);
        uint160 upper = TickMath.getSqrtPriceAtTick(seed.tickUpper);
        bool tokenIsZero = seed.token == Currency.unwrap(seed.key.currency0);
        if (tokenIsZero) {
            // amount0 = L * (upper - lower) / (lower * upper) , in Q96 terms
            uint256 intermediate = (uint256(lower) * uint256(upper)) / (1 << 96);
            return uint128((seed.amount * intermediate) / (uint256(upper) - uint256(lower)));
        }
        // amount1 = L * (upper - lower) / 2**96
        return uint128((seed.amount * (1 << 96)) / (uint256(upper) - uint256(lower)));
    }
}

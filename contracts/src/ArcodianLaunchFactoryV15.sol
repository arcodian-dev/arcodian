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
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {PumpToken} from "./ArcPump.sol";
import {ArcodianLaunchHookV15} from "./ArcodianLaunchHookV15.sol";

/// @notice Launches a coin straight into a tradeable Uniswap V4 pool — V15.
///
/// V14's pool launch with the fee model the curve engines always had:
///
/// - 1% per trade, in USDC, half to the creator (the V15 hook, as in V14).
/// - 1% ONE-TIME GRADUATION FEE, in USDC, at 12,000 USDC raised. V13 and V14
///   took their one-time 1% out of the token supply at launch instead, which
///   left the treasury holding the coin — visible in every holder list, and
///   paid in the asset rather than in USDC. V15 seeds the pool with the whole
///   supply and takes nothing at launch.
///
/// Graduation. A V4 launch trades in its pool from the first block, so there
/// is no venue to move to; what graduation means here is the milestone and
/// its fee. The swap that carries the pool's USDC past GRADUATION_QUOTE
/// triggers it through the hook: this factory removes 1% of its own position
/// — 1% of the USDC raised and 1% of the tokens still in the pool — sends the
/// USDC to the treasury (as a claim on the hook) and burns the tokens (as
/// claims minted to the dead address, which can never be redeemed). It
/// happens once per launch. The price does not move: removing a slice of a
/// position changes depth, not price.
///
/// That removal is the only code path that ever touches the position, it is
/// fixed at exactly 1%, it runs once, and its proceeds can only go to the
/// treasury and the burn address. The remaining 99% stays locked for good.
///
/// Also kept from V14: the 0% LP tier and the optional launch buy.
contract ArcodianLaunchFactoryV15 is IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint8 public constant ENGINE_VERSION = 15;
    /// USDC (6 decimals) in the pool at which a launch graduates.
    uint256 public constant GRADUATION_QUOTE = 12_000e6;
    /// Share of the position removed once, at graduation, as the fee.
    uint128 public constant GRADUATION_FEE_BPS = 100;
    /// Fee tier and spacing of the pool that gets opened. Zero LP fee: the
    /// hook's 1% is the whole cost of a trade.
    uint24 public constant POOL_FEE = 0;
    int24 public constant TICK_SPACING = 60;
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    IPoolManager public immutable poolManager;
    ArcodianLaunchHookV15 public immutable hook;
    Currency public immutable quote;
    address payable public immutable treasury;

    uint256 public launchCount;
    mapping(uint256 => address) public tokenByLaunch;
    mapping(uint256 => PoolId) public poolByLaunch;
    mapping(address => PoolId) public poolForToken;
    mapping(address => bool) public isLaunch;
    mapping(PoolId => uint256) public launchIdByPool;
    /// Liquidity of the launch's position as seeded.
    mapping(uint256 => uint128) public liquidityByLaunch;
    mapping(uint256 => bool) public graduatedLaunch;

    event LaunchCreated(uint256 indexed id, address indexed creator, address token, PoolId poolId, uint256 tokenLiquidity, uint256 launchFee);
    event InitialBuy(uint256 indexed id, address indexed creator, uint256 quoteIn, uint256 tokensOut);
    event Graduated(uint256 indexed id, PoolId poolId, uint256 quoteRaised, uint256 quoteFee, uint256 tokensBurned);

    error NotPoolManager();
    error BadMetadata();
    error NotHook();
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

    constructor(IPoolManager poolManager_, ArcodianLaunchHookV15 hook_, Currency quote_, address payable treasury_) {
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

        // The whole supply goes into the pool. Nothing is taken at launch; the
        // one-time fee is charged in USDC at graduation instead.
        uint256 launchFee = 0;
        uint256 seedAmount = supply;

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
        // Known before the seed/buy unlock: a launch buy large enough to
        // cross the graduation line graduates inside this transaction.
        uint256 id = ++launchCount;
        launchIdByPool[poolId] = id;
        tokenByLaunch[id] = tokenAddress;
        poolByLaunch[id] = poolId;
        poolForToken[tokenAddress] = poolId;
        isLaunch[tokenAddress] = true;

        bytes memory result = poolManager.unlock(abi.encode(SeedData({
            key: key, token: tokenAddress, amount: seedAmount, tickLower: tickLower, tickUpper: tickUpper,
            buyer: msg.sender, initialBuy: initialBuy, minTokensOut: minTokensOut
        })));
        tokensBought = abi.decode(result, (uint256));

        emit LaunchCreated(id, msg.sender, tokenAddress, poolId, seedAmount, launchFee);
        if (initialBuy != 0) emit InitialBuy(id, msg.sender, initialBuy, tokensBought);
    }

    /// @notice USDC (6 decimals) currently in a launch's position — what its
    /// buyers have put in, net of sells.
    function quoteRaised(uint256 id) public view returns (uint256) {
        address token = tokenByLaunch[id];
        uint128 liquidity = liquidityByLaunch[id];
        if (token == address(0) || liquidity == 0) return 0;
        bool tokenIsZero = token < Currency.unwrap(quote);
        (uint160 sqrtPrice,,,) = poolManager.getSlot0(poolByLaunch[id]);
        (int24 tickLower, int24 tickUpper,) = _range(tokenIsZero);
        uint160 lower = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 upper = TickMath.getSqrtPriceAtTick(tickUpper);
        uint160 p = sqrtPrice < lower ? lower : sqrtPrice > upper ? upper : sqrtPrice;
        if (graduatedLaunch[id]) liquidity -= (liquidity * GRADUATION_FEE_BPS) / 10_000;
        // The quote is currency1 when the token is currency0, and vice versa.
        return tokenIsZero
            ? SqrtPriceMath.getAmount1Delta(lower, p, liquidity, false)
            : SqrtPriceMath.getAmount0Delta(p, upper, liquidity, false);
    }

    /// @notice Called by the hook after every swap on a pool that has not
    /// graduated. Graduates it if that swap carried it past the line.
    /// @dev Runs inside the swapper's unlock, mid-swap, so nothing here may
    /// take() real tokens: on a pool whose first buy crosses the line, the
    /// manager has not been paid yet. Proceeds are minted as ERC-6909 claims
    /// instead, which is pure accounting — the treasury's USDC to the hook
    /// (redeemed through hook.claim) and the tokens to the dead address.
    function onSwap(PoolKey calldata key) external {
        if (msg.sender != address(hook)) revert NotHook();
        PoolId poolId = key.toId();
        uint256 id = launchIdByPool[poolId];
        // Zero during createLaunch's own seed, before liquidity is recorded.
        if (id == 0 || graduatedLaunch[id] || liquidityByLaunch[id] == 0) return;
        uint256 raised = quoteRaised(id);
        if (raised < GRADUATION_QUOTE) return;

        graduatedLaunch[id] = true;
        address token = tokenByLaunch[id];
        bool tokenIsZero = token < Currency.unwrap(quote);
        (int24 tickLower, int24 tickUpper,) = _range(tokenIsZero);
        uint128 slice = (liquidityByLaunch[id] * GRADUATION_FEE_BPS) / 10_000;
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({ tickLower: tickLower, tickUpper: tickUpper, liquidityDelta: -int256(uint256(slice)), salt: 0 }),
            ""
        );
        uint256 quoteOut = uint256(uint128(tokenIsZero ? delta.amount1() : delta.amount0()));
        uint256 tokensOut = uint256(uint128(tokenIsZero ? delta.amount0() : delta.amount1()));
        if (quoteOut != 0) poolManager.mint(address(hook), quote.toId(), quoteOut);
        if (tokensOut != 0) poolManager.mint(BURN, Currency.wrap(token).toId(), tokensOut);
        hook.recordGraduation(poolId, quoteOut);
        emit Graduated(id, poolId, raised, quoteOut, tokensOut);
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
        liquidityByLaunch[launchIdByPool[seed.key.toId()]] = liquidity;
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

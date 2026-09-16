// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PumpToken} from "./ArcPump.sol";
import {IERC20} from "./ArcFxPool.sol";
import {ErcPullFeeVault} from "./ArcPumpEurc.sol";
import {IUniswapV3FactoryV10, IUniswapV3PoolV10, INonfungiblePositionManagerV10} from "./ArcPumpV10.sol";

/// @notice The EURC mirror of ArcPumpV11: identical curve math, identical fee
/// design, identical Uniswap V3 graduation (including the price-manipulation
/// guard), with EURC as the quote currency instead of native USDC.
///
/// This exists because the two EURC engines that came before it both graduate
/// somewhere Arc Mainnet cannot use. V7 graduated into ArcDexFactoryEurc, a
/// venue nothing else could reach. V8 moved that to ArcPair — correct on
/// testnet, but on Arc Mainnet `ArcPairFactoryV2.graduationAuthority()` is
/// still the zero address and `allPairsLength()` is 0: nothing has ever
/// graduated there, because the live USDC engine (V11) graduates into
/// Uniswap V3 instead. Wiring V8 into mainnet would have meant calling
/// `setGraduationAuthority`, which is one-time and self-locking, permanently
/// binding mainnet ArcPair graduation to the EURC factory. This contract
/// avoids that decision entirely by graduating where V11 already does.
///
/// Simpler than the USDC path in one respect worth stating plainly: EURC is an
/// ordinary 6-decimal ERC-20 with no dual native/precompile interface, so
/// there is no 1e12 scaling and no unit conversion at settlement — the quote
/// amount a buyer sends is the same number that ends up in the LP position.
/// That also means this graduation path can be exercised end to end in Foundry
/// against a plain mock, which the USDC path cannot, because its precompile
/// does not exist in a local EVM.
///
/// Fee surface is deliberately identical to V11, not re-chosen here: 1% on
/// every trade split 50/50 between the launch's creator (pull-claimed) and the
/// protocol treasury, plus a separate one-time 1% graduation fee taken out of
/// the quote liquidity at graduation, 100% to treasury.
contract ArcPumpCurveEurcV11 is ErcPullFeeVault {
    uint8 public constant ENGINE_VERSION = 11;
    uint8 public constant QUOTE_KIND = 1; // 0 = native USDC, 1 = EURC

    uint24 public constant GRADUATION_FEE = 3000;
    int24 public constant TICK_LOWER = -887220;
    int24 public constant TICK_UPPER = 887220;
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant CURVE_FEE_BPS = 100;
    uint256 public constant CREATOR_FEE_BPS = 50;
    uint256 public constant PROTOCOL_FEE_BPS = CURVE_FEE_BPS - CREATOR_FEE_BPS;
    uint256 public constant GRADUATION_FEE_BPS = 100;
    uint256 public constant CURVE_SUPPLY = 800_000_000 ether;
    uint256 public constant LP_RESERVE = 200_000_000 ether;
    /// 4,500 EURC at 6 decimals — the same virtual reserve V11 uses (4_500
    /// ether of 18-decimal native), so both engines price a launch identically
    /// in units of their own quote currency.
    uint256 public constant VIRTUAL_QUOTE = 4_500_000_000;
    uint256 public constant MINT_SLIPPAGE_BPS = 200;

    PumpToken public immutable token;
    IUniswapV3FactoryV10 public immutable v3Factory;
    INonfungiblePositionManagerV10 public immutable positionManager;
    address public immutable creator;
    uint256 public immutable graduationThreshold;
    uint256 public realQuoteReserve;
    uint256 public curveSold;
    uint256 public creatorFeesAccrued;
    bool public graduated;
    address public pool;
    uint256 public lpTokenId;
    uint256 public graduationFeeTaken;
    bool private locked;

    event Bought(address indexed buyer, uint256 quoteIn, uint256 tokensOut, uint256 protocolFee);
    event Sold(address indexed seller, uint256 tokensIn, uint256 quoteOut, uint256 protocolFee);
    event Graduated(address indexed pool, uint256 tokenLiquidity, uint256 quoteLiquidity, uint256 lpTokenId, uint256 graduationFee);
    event CreatorFeeAccrued(uint256 amount, uint256 totalAccrued);
    event CreatorFeesWithdrawn(address indexed creator, uint256 amount);

    modifier nonReentrant() {
        require(!locked && !feeLocked, "REENTRANCY");
        locked = true;
        feeLocked = true;
        _;
        feeLocked = false;
        locked = false;
    }

    constructor(
        PumpToken token_,
        IUniswapV3FactoryV10 v3Factory_,
        INonfungiblePositionManagerV10 positionManager_,
        address creator_,
        IERC20 quote_,
        address payable treasury_,
        uint256 threshold_
    ) ErcPullFeeVault(quote_, treasury_) {
        require(
            address(token_) != address(0) && address(v3Factory_) != address(0)
                && address(positionManager_) != address(0) && creator_ != address(0)
                && threshold_ > VIRTUAL_QUOTE,
            "BAD_INIT"
        );
        token = token_;
        v3Factory = v3Factory_;
        positionManager = positionManager_;
        creator = creator_;
        graduationThreshold = threshold_;
    }

    /// @notice Buy along the curve with `quoteIn` of the quote token.
    ///
    /// The quote arrives by transferFrom rather than with the call, so unlike
    /// V11 this measures what actually landed instead of trusting the argument.
    /// EURC is not a fee-on-transfer token, but a curve that credits an amount
    /// it never received is insolvent by exactly that difference, and the check
    /// costs one balance read.
    function buy(uint256 quoteIn, uint256 minTokensOut, uint64 deadline) external nonReentrant returns (uint256 out) {
        require(!graduated && block.timestamp <= deadline && quoteIn > 0, "CURVE_CLOSED");
        uint256 before = quote.balanceOf(address(this));
        require(quote.transferFrom(msg.sender, address(this), quoteIn), "QUOTE_IN");
        uint256 received = quote.balanceOf(address(this)) - before;
        require(received == quoteIn, "QUOTE_SHORTFALL");

        uint256 fee = quoteIn * CURVE_FEE_BPS / 10_000;
        uint256 netIn = quoteIn - fee;
        uint256 inventory = CURVE_SUPPLY - curveSold;
        uint256 x = VIRTUAL_QUOTE + realQuoteReserve;
        out = inventory - (x * inventory / (x + netIn));
        require(out >= minTokensOut && out > 0, "SLIPPAGE");
        curveSold += out;
        realQuoteReserve += netIn;
        _splitFee(quoteIn);
        require(token.transfer(msg.sender, out), "TOKEN_OUT");
        emit Bought(msg.sender, quoteIn, out, fee);
        if (realQuoteReserve >= graduationThreshold) _graduate();
    }

    function sell(uint256 tokenIn, uint256 minQuoteOut, uint64 deadline) external nonReentrant returns (uint256 out) {
        require(!graduated && block.timestamp <= deadline && tokenIn > 0 && tokenIn <= curveSold, "CURVE_CLOSED");
        uint256 inventory = CURVE_SUPPLY - curveSold;
        uint256 x = VIRTUAL_QUOTE + realQuoteReserve;
        uint256 grossOut = x - (x * inventory / (inventory + tokenIn));
        if (grossOut > realQuoteReserve) grossOut = realQuoteReserve;
        uint256 fee = grossOut * CURVE_FEE_BPS / 10_000;
        out = grossOut - fee;
        require(out >= minQuoteOut && out > 0, "SLIPPAGE");
        require(token.transferFrom(msg.sender, address(this), tokenIn), "TOKEN_IN");
        curveSold -= tokenIn;
        realQuoteReserve -= grossOut;
        _splitFee(grossOut);
        require(quote.transfer(msg.sender, out), "QUOTE_OUT");
        emit Sold(msg.sender, tokenIn, out, fee);
    }

    /// Splits CURVE_FEE_BPS of `base` between creator and protocol. Each cut is
    /// computed independently off `base` rather than halving the combined fee,
    /// so no rounding remainder is silently dropped — protocolCut is whatever
    /// remains of `fee`, so the two always sum to exactly `fee`.
    function _splitFee(uint256 base) private {
        uint256 fee = base * CURVE_FEE_BPS / 10_000;
        uint256 creatorCut = base * CREATOR_FEE_BPS / 10_000;
        uint256 protocolCut = fee - creatorCut;
        creatorFeesAccrued += creatorCut;
        emit CreatorFeeAccrued(creatorCut, creatorFeesAccrued);
        _accrueFee(protocolCut);
    }

    /// @notice Pull-claim the creator's accrued share, mirroring
    /// withdrawProtocolFees()'s reentrancy-safe pattern exactly — it shares the
    /// same `feeLocked` flag, so a creator and the treasury can never both be
    /// mid-withdraw at once.
    function withdrawCreatorFees() external {
        require(msg.sender == creator, "CREATOR_ONLY");
        require(!feeLocked, "REENTRANCY");
        feeLocked = true;
        uint256 amount = creatorFeesAccrued;
        require(amount > 0, "NO_FEES");
        creatorFeesAccrued = 0;
        require(quote.transfer(creator, amount), "WITHDRAW_FAILED");
        feeLocked = false;
        emit CreatorFeesWithdrawn(creator, amount);
    }

    function _graduate() private {
        graduated = true;
        uint256 quoteLiquidity = realQuoteReserve;
        realQuoteReserve = 0;
        // One-time graduation fee, 100% to treasury, taken off the top before
        // any of it becomes the LP position — so it is paid once by the launch
        // itself, not by whichever trader's buy happened to cross the threshold.
        graduationFeeTaken = quoteLiquidity * GRADUATION_FEE_BPS / 10_000;
        quoteLiquidity -= graduationFeeTaken;
        _accrueFee(graduationFeeTaken);
        require(quoteLiquidity > 0, "NO_LIQUIDITY");

        uint256 unsoldCurve = CURVE_SUPPLY - curveSold;
        if (unsoldCurve > 0) require(token.transfer(BURN, unsoldCurve), "BURN_UNSOLD");

        // Split out of this function rather than inlined: _graduate() sits at
        // the EVM stack-depth limit here exactly as V11's does — "stack too
        // deep" is a real compiler error at this size, not a style preference.
        address poolAddress = address(token) < address(quote)
            ? _openPosition(address(token), address(quote), LP_RESERVE, quoteLiquidity)
            : _openPosition(address(quote), address(token), quoteLiquidity, LP_RESERVE);
        emit Graduated(poolAddress, LP_RESERVE, quoteLiquidity, lpTokenId, graduationFeeTaken);
    }

    /// Creates or reuses the V3 pool, refuses a manipulated price, and mints
    /// the whole position to the burn address so the liquidity is permanent.
    function _openPosition(address token0, address token1, uint256 amount0, uint256 amount1)
        private
        returns (address poolAddress)
    {
        poolAddress = v3Factory.getPool(token0, token1, GRADUATION_FEE);
        if (poolAddress == address(0)) poolAddress = v3Factory.createPool(token0, token1, GRADUATION_FEE);
        pool = poolAddress;
        uint160 expectedPrice = _sqrtPriceX96(amount0, amount1);
        (uint160 existingPrice,,,,,,) = IUniswapV3PoolV10(poolAddress).slot0();
        if (existingPrice == 0) {
            IUniswapV3PoolV10(poolAddress).initialize(expectedPrice);
        } else {
            // Anyone can create and price this pool before graduation reaches
            // it. Minting into a manipulated price would hand them the
            // difference, so graduation refuses rather than proceeding.
            uint256 diff = existingPrice > expectedPrice ? existingPrice - expectedPrice : expectedPrice - existingPrice;
            require(diff * 10_000 <= uint256(expectedPrice) * MINT_SLIPPAGE_BPS, "POOL_PRICE_MANIPULATED");
        }
        require(token.approve(address(positionManager), token0 == address(token) ? amount0 : amount1), "APPROVE_TOKEN");
        require(quote.approve(address(positionManager), token0 == address(quote) ? amount0 : amount1), "APPROVE_QUOTE");
        (lpTokenId,,,) = positionManager.mint(
            INonfungiblePositionManagerV10.MintParams({
                token0: token0,
                token1: token1,
                fee: GRADUATION_FEE,
                tickLower: TICK_LOWER,
                tickUpper: TICK_UPPER,
                amount0Desired: amount0,
                amount1Desired: amount1,
                amount0Min: amount0 - amount0 * MINT_SLIPPAGE_BPS / 10_000,
                amount1Min: amount1 - amount1 * MINT_SLIPPAGE_BPS / 10_000,
                recipient: BURN,
                deadline: block.timestamp
            })
        );
    }

    function _sqrtPriceX96(uint256 amount0, uint256 amount1) private pure returns (uint160) {
        uint256 s0 = _sqrt(amount0);
        require(s0 > 0, "ZERO_SQRT");
        return uint160((_sqrt(amount1) << 96) / s0);
    }

    function _sqrt(uint256 x) private pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}

contract ArcPumpFactoryEurcV11 {
    uint8 public constant ENGINE_VERSION = 11;
    uint8 public constant QUOTE_KIND = 1;
    IUniswapV3FactoryV10 public immutable v3Factory;
    INonfungiblePositionManagerV10 public immutable positionManager;
    IERC20 public immutable quote;
    uint256 public immutable graduationThreshold;
    address payable public immutable treasury;
    uint256 public launchCount;
    mapping(uint256 => address) public tokenByLaunch;
    mapping(uint256 => address) public curveByLaunch;
    mapping(address => address) public curveForToken;
    mapping(address => bool) public isCurve;
    event LaunchCreated(uint256 indexed id, address indexed creator, address token, address curve);

    constructor(
        IUniswapV3FactoryV10 v3Factory_,
        INonfungiblePositionManagerV10 positionManager_,
        IERC20 quote_,
        address payable treasury_,
        uint256 threshold_
    ) {
        require(
            address(v3Factory_) != address(0) && address(positionManager_) != address(0)
                && address(quote_) != address(0) && treasury_ != address(0)
                // 1,000 EURC at 6 decimals — the same floor V11 applies in its
                // own quote units (1_000 ether of 18-decimal native).
                && threshold_ > 1_000_000_000,
            "BAD_CONFIG"
        );
        v3Factory = v3Factory_;
        positionManager = positionManager_;
        quote = quote_;
        treasury = treasury_;
        graduationThreshold = threshold_;
    }

    function isUngraduatedLaunchToken(address token) external view returns (bool) {
        address curve = curveForToken[token];
        return curve != address(0) && !ArcPumpCurveEurcV11(curve).graduated();
    }

    function createLaunch(string calldata name, string calldata symbol, string calldata imageURI)
        external
        returns (address tokenAddress, address curveAddress)
    {
        require(bytes(name).length <= 40 && bytes(symbol).length >= 2 && bytes(symbol).length <= 10 && bytes(imageURI).length <= 200, "BAD_METADATA");
        PumpToken token = new PumpToken(name, symbol, imageURI, address(this));
        ArcPumpCurveEurcV11 curve =
            new ArcPumpCurveEurcV11(token, v3Factory, positionManager, msg.sender, quote, treasury, graduationThreshold);
        require(token.transfer(address(curve), token.totalSupply()), "CURVE_ALLOCATION");
        address tokenAddr = address(token);
        uint256 id = ++launchCount;
        tokenByLaunch[id] = tokenAddr;
        curveByLaunch[id] = address(curve);
        curveForToken[tokenAddr] = address(curve);
        isCurve[address(curve)] = true;
        emit LaunchCreated(id, msg.sender, tokenAddr, address(curve));
        return (tokenAddr, address(curve));
    }
}

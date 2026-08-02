// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// src/ArcFxPool.sol

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @notice Minimal constant-product AMM for two 6-decimal stablecoins on Arc:
/// USDC (ERC-20 interface at 0x3600…) and EURC. Powers the in-app USDC<->EURC FX
/// widget. Owner-seeded single-LP design (testnet FX utility); owner can top up
/// and withdraw. Swaps carry a small fee that stays in the pool (accrues to the
/// owner LP). No native value handling — both legs are standard ERC-20 transfers.
contract ArcFxPool {
    IERC20 public immutable usdc;
    IERC20 public immutable eurc;
    address public immutable owner;
    uint256 public constant FEE_BPS = 10; // 0.10%
    uint256 public reserveUsdc;
    uint256 public reserveEurc;
    bool private locked;

    event Seeded(uint256 usdcAmount, uint256 eurcAmount);
    event Funded(bool usdcSide, uint256 amount);
    event Swapped(address indexed trader, bool usdcToEurc, uint256 amountIn, uint256 amountOut);
    event Withdrawn(address indexed to, uint256 usdcAmount, uint256 eurcAmount);

    modifier nonReentrant() {
        require(!locked, "REENTRANCY");
        locked = true;
        _;
        locked = false;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "OWNER_ONLY");
        _;
    }

    constructor(IERC20 usdc_, IERC20 eurc_) {
        require(address(usdc_) != address(0) && address(eurc_) != address(0), "ZERO_ADDRESS");
        usdc = usdc_;
        eurc = eurc_;
        owner = msg.sender;
    }

    /// @notice Seed initial reserves. Both amounts must be pulled successfully.
    function seed(uint256 usdcAmount, uint256 eurcAmount) external onlyOwner nonReentrant {
        require(reserveUsdc == 0 && reserveEurc == 0, "ALREADY_SEEDED");
        require(usdcAmount > 0 && eurcAmount > 0, "ZERO_SEED");
        require(usdc.transferFrom(msg.sender, address(this), usdcAmount), "USDC_IN");
        require(eurc.transferFrom(msg.sender, address(this), eurcAmount), "EURC_IN");
        reserveUsdc = usdcAmount;
        reserveEurc = eurcAmount;
        emit Seeded(usdcAmount, eurcAmount);
    }

    /// @notice Owner tops up one side to deepen liquidity / rebalance price.
    function fund(bool usdcSide, uint256 amount) external onlyOwner nonReentrant {
        require(amount > 0, "ZERO");
        if (usdcSide) {
            require(usdc.transferFrom(msg.sender, address(this), amount), "USDC_IN");
            reserveUsdc += amount;
        } else {
            require(eurc.transferFrom(msg.sender, address(this), amount), "EURC_IN");
            reserveEurc += amount;
        }
        emit Funded(usdcSide, amount);
    }

    /// @notice Quote output for a given input without mutating state.
    function quote(bool usdcToEurc, uint256 amountIn) public view returns (uint256 out) {
        if (amountIn == 0 || reserveUsdc == 0 || reserveEurc == 0) return 0;
        (uint256 reserveIn, uint256 reserveOut) = usdcToEurc ? (reserveUsdc, reserveEurc) : (reserveEurc, reserveUsdc);
        uint256 inWithFee = amountIn * (10_000 - FEE_BPS);
        out = reserveOut * inWithFee / (reserveIn * 10_000 + inWithFee);
    }

    /// @notice Swap USDC<->EURC. Pulls amountIn from the caller, sends >= minOut back.
    function swap(bool usdcToEurc, uint256 amountIn, uint256 minOut, uint64 deadline)
        external
        nonReentrant
        returns (uint256 out)
    {
        require(block.timestamp <= deadline, "EXPIRED");
        require(amountIn > 0 && reserveUsdc > 0 && reserveEurc > 0, "BAD_SWAP");
        out = quote(usdcToEurc, amountIn);
        require(out >= minOut && out > 0, "SLIPPAGE");
        (IERC20 tokenIn, IERC20 tokenOut) = usdcToEurc ? (usdc, eurc) : (eurc, usdc);
        require(tokenIn.transferFrom(msg.sender, address(this), amountIn), "TOKEN_IN");
        if (usdcToEurc) {
            reserveUsdc += amountIn;
            reserveEurc -= out;
        } else {
            reserveEurc += amountIn;
            reserveUsdc -= out;
        }
        require(tokenOut.transfer(msg.sender, out), "TOKEN_OUT");
        emit Swapped(msg.sender, usdcToEurc, amountIn, out);
    }

    /// @notice Owner recovers liquidity (e.g. to reseed at a corrected rate).
    function withdraw(address to, uint256 usdcAmount, uint256 eurcAmount) external onlyOwner nonReentrant {
        require(to != address(0), "ZERO_TO");
        require(usdcAmount <= reserveUsdc && eurcAmount <= reserveEurc, "INSUFFICIENT");
        reserveUsdc -= usdcAmount;
        reserveEurc -= eurcAmount;
        if (usdcAmount > 0) require(usdc.transfer(to, usdcAmount), "USDC_OUT");
        if (eurcAmount > 0) require(eurc.transfer(to, eurcAmount), "EURC_OUT");
        emit Withdrawn(to, usdcAmount, eurcAmount);
    }
}

// src/ArcPump.sol

contract PumpToken {
    string public name;
    string public symbol;
    string public imageURI;
    uint8 public constant decimals = 18;
    uint256 public constant totalSupply = 1_000_000_000 ether;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, string memory imageURI_, address receiver) {
        require(bytes(name_).length > 0 && bytes(symbol_).length >= 2 && bytes(imageURI_).length <= 200 && receiver != address(0), "BAD_METADATA");
        name = name_; symbol = symbol_; imageURI = imageURI_; balanceOf[receiver] = totalSupply;
        emit Transfer(address(0), receiver, totalSupply);
    }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; emit Approval(msg.sender, spender, amount); return true; }
    function transfer(address to, uint256 amount) external returns (bool) { _transfer(msg.sender, to, amount); return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) { uint256 a = allowance[from][msg.sender]; if (a != type(uint256).max) allowance[from][msg.sender] = a - amount; _transfer(from, to, amount); return true; }
    function _transfer(address from, address to, uint256 amount) internal { require(to != address(0), "ZERO_TO"); balanceOf[from] -= amount; unchecked { balanceOf[to] += amount; } emit Transfer(from, to, amount); }
}

contract ArcDexPair {
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;
    PumpToken public immutable token;
    address public immutable initializer;
    address payable public immutable treasury;
    uint256 public constant TOTAL_FEE_BPS = 30;
    uint256 public constant PROTOCOL_FEE_BPS = 5;
    uint256 public tokenReserve;
    uint256 public nativeReserve;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    bool private locked;
    event LiquidityBurned(uint256 tokenAmount, uint256 nativeAmount, uint256 lpAmount);
    event Swap(address indexed trader, bool nativeToToken, uint256 amountIn, uint256 amountOut, uint256 protocolFee);
    modifier nonReentrant() { require(!locked, "REENTRANCY"); locked = true; _; locked = false; }

    constructor(PumpToken token_, address initializer_, address payable treasury_) { require(address(token_) != address(0) && initializer_ != address(0) && treasury_ != address(0), "ZERO_ADDRESS"); token = token_; initializer = initializer_; treasury = treasury_; }

    function initialize(uint256 tokenAmount) external payable nonReentrant {
        require(msg.sender == initializer && totalSupply == 0 && msg.value > 0 && tokenAmount > 0, "BAD_INIT");
        require(token.transferFrom(msg.sender, address(this), tokenAmount), "TOKEN_IN");
        tokenReserve = tokenAmount; nativeReserve = msg.value;
        uint256 lp = _sqrt(tokenAmount * msg.value);
        require(lp > 0, "ZERO_LP"); totalSupply = lp; balanceOf[BURN] = lp;
        emit LiquidityBurned(tokenAmount, msg.value, lp);
    }

    function buy(uint256 minTokensOut, uint64 deadline) external payable nonReentrant returns (uint256 out) {
        require(block.timestamp <= deadline && msg.value > 0 && totalSupply > 0, "BAD_SWAP");
        uint256 inWithFee = msg.value * (10_000 - TOTAL_FEE_BPS);
        out = tokenReserve * inWithFee / (nativeReserve * 10_000 + inWithFee);
        require(out >= minTokensOut && out > 0, "SLIPPAGE");
        uint256 protocolFee = msg.value * PROTOCOL_FEE_BPS / 10_000;
        nativeReserve += msg.value - protocolFee; tokenReserve -= out;
        require(token.transfer(msg.sender, out), "TOKEN_OUT");
        (bool feeOk,) = treasury.call{value: protocolFee}(""); require(feeOk, "FEE_OUT");
        emit Swap(msg.sender, true, msg.value, out, protocolFee);
    }

    function sell(uint256 tokenIn, uint256 minNativeOut, uint64 deadline) external nonReentrant returns (uint256 out) {
        require(block.timestamp <= deadline && tokenIn > 0 && totalSupply > 0, "BAD_SWAP");
        uint256 inWithFee = tokenIn * (10_000 - 25);
        uint256 grossOut = nativeReserve * inWithFee / (tokenReserve * 10_000 + inWithFee);
        uint256 protocolFee = grossOut * PROTOCOL_FEE_BPS / 10_000; out = grossOut - protocolFee;
        require(out >= minNativeOut && out > 0, "SLIPPAGE");
        require(token.transferFrom(msg.sender, address(this), tokenIn), "TOKEN_IN");
        tokenReserve += tokenIn; nativeReserve -= grossOut;
        (bool feeOk,) = treasury.call{value: protocolFee}(""); require(feeOk, "FEE_OUT");
        (bool ok,) = msg.sender.call{value: out}(""); require(ok, "NATIVE_OUT"); emit Swap(msg.sender, false, tokenIn, out, protocolFee);
    }

    function _sqrt(uint256 y) private pure returns (uint256 z) { if (y > 3) { z = y; uint256 x = y / 2 + 1; while (x < z) { z = x; x = (y / x + x) / 2; } } else if (y != 0) z = 1; }
}

contract ArcDexFactory {
    address public immutable owner;
    address payable public immutable treasury;
    address public pumpFactory;
    mapping(address => address) public pairFor;
    mapping(address => address) public curveFor;
    event PairCreated(address indexed token, address indexed pair, address indexed initializer);
    constructor(address payable treasury_) { require(treasury_ != address(0), "ZERO_ADDRESS"); owner = msg.sender; treasury = treasury_; }
    function setPumpFactory(address pumpFactory_) external {
        require(msg.sender == owner && pumpFactory == address(0) && pumpFactory_ != address(0), "NOT_AUTHORIZED");
        pumpFactory = pumpFactory_;
    }
    function registerCurve(PumpToken token, address curve) external {
        require(msg.sender == pumpFactory && curveFor[address(token)] == address(0) && curve != address(0), "NOT_AUTHORIZED");
        curveFor[address(token)] = curve;
    }
    function createPair(PumpToken token, address initializer) external returns (ArcDexPair pair) {
        require(msg.sender == initializer && curveFor[address(token)] == initializer, "NOT_AUTHORIZED");
        require(pairFor[address(token)] == address(0), "PAIR_EXISTS");
        pair = new ArcDexPair(token, initializer, treasury); pairFor[address(token)] = address(pair); emit PairCreated(address(token), address(pair), initializer);
    }
}

contract ArcPumpCurve {
    PumpToken public immutable token;
    ArcDexFactory public immutable dexFactory;
    address public immutable creator;
    address payable public immutable treasury;
    uint256 public constant CURVE_FEE_BPS = 100;
    uint256 public immutable graduationThreshold;
    /// @notice 1,000 USDC virtual reserve gives a 1,000 USDC initial FDV
    /// for the fixed 1B supply and leaves ~18.18% for LP at a 4,500 USDC raise.
    uint256 public constant VIRTUAL_NATIVE = 1_000 ether;
    uint256 public realNativeReserve;
    bool public graduated;
    ArcDexPair public pair;
    bool private locked;
    event Bought(address indexed buyer, uint256 nativeIn, uint256 tokensOut, uint256 protocolFee);
    event Sold(address indexed seller, uint256 tokensIn, uint256 nativeOut, uint256 protocolFee);
    event Graduated(address indexed pair, uint256 tokenLiquidity, uint256 nativeLiquidity, address lpBurnAddress);
    modifier nonReentrant() { require(!locked, "REENTRANCY"); locked = true; _; locked = false; }

    constructor(PumpToken token_, ArcDexFactory dexFactory_, address creator_, address payable treasury_, uint256 threshold_) {
        require(address(token_) != address(0) && address(dexFactory_) != address(0) && creator_ != address(0) && treasury_ != address(0) && threshold_ > VIRTUAL_NATIVE, "BAD_INIT");
        token = token_; dexFactory = dexFactory_; creator = creator_; treasury = treasury_; graduationThreshold = threshold_;
    }

    function buy(uint256 minTokensOut, uint64 deadline) external payable nonReentrant returns (uint256 out) {
        require(!graduated && block.timestamp <= deadline && msg.value > 0, "CURVE_CLOSED");
        uint256 fee = msg.value * CURVE_FEE_BPS / 10_000; uint256 netIn = msg.value - fee; require(netIn > 0, "ZERO_NET");
        uint256 inventory = token.balanceOf(address(this));
        uint256 x = VIRTUAL_NATIVE + realNativeReserve;
        uint256 newY = x * inventory / (x + netIn);
        out = inventory - newY;
        require(out >= minTokensOut && out > 0, "SLIPPAGE");
        realNativeReserve += netIn; require(token.transfer(msg.sender, out), "TOKEN_OUT");
        (bool feeOk,) = treasury.call{value: fee}(""); require(feeOk, "FEE_OUT"); emit Bought(msg.sender, msg.value, out, fee);
        if (realNativeReserve >= graduationThreshold) _graduate();
    }

    function sell(uint256 tokenIn, uint256 minNativeOut, uint64 deadline) external nonReentrant returns (uint256 out) {
        require(!graduated && block.timestamp <= deadline && tokenIn > 0, "CURVE_CLOSED");
        uint256 inventory = token.balanceOf(address(this));
        uint256 x = VIRTUAL_NATIVE + realNativeReserve;
        uint256 newX = x * inventory / (inventory + tokenIn);
        uint256 grossOut = x - newX; if (grossOut > realNativeReserve) grossOut = realNativeReserve;
        uint256 fee = grossOut * CURVE_FEE_BPS / 10_000; out = grossOut - fee;
        require(out >= minNativeOut && out > 0, "SLIPPAGE");
        require(token.transferFrom(msg.sender, address(this), tokenIn), "TOKEN_IN");
        realNativeReserve -= grossOut;
        (bool feeOk,) = treasury.call{value: fee}(""); require(feeOk, "FEE_OUT");
        (bool ok,) = msg.sender.call{value: out}(""); require(ok, "NATIVE_OUT"); emit Sold(msg.sender, tokenIn, out, fee);
    }

    function _graduate() private {
        graduated = true; uint256 tokenLiquidity = token.balanceOf(address(this)); uint256 nativeLiquidity = realNativeReserve; realNativeReserve = 0;
        pair = dexFactory.createPair(token, address(this)); require(token.approve(address(pair), tokenLiquidity), "APPROVE");
        pair.initialize{value: nativeLiquidity}(tokenLiquidity);
        emit Graduated(address(pair), tokenLiquidity, nativeLiquidity, pair.BURN());
    }
}

contract ArcPumpFactory {
    ArcDexFactory public immutable dexFactory;
    uint256 public immutable graduationThreshold;
    address payable public immutable treasury;
    uint256 public launchCount;
    mapping(uint256 => address) public tokenByLaunch;
    mapping(uint256 => address) public curveByLaunch;
    event LaunchCreated(uint256 indexed id, address indexed creator, address token, address curve);

    constructor(ArcDexFactory dexFactory_, address payable treasury_, uint256 threshold_) { require(address(dexFactory_) != address(0) && treasury_ != address(0) && threshold_ > 1_000 ether, "BAD_CONFIG"); dexFactory = dexFactory_; treasury = treasury_; graduationThreshold = threshold_; }
    function createLaunch(string calldata name, string calldata symbol, string calldata imageURI) external returns (address tokenAddress, address curveAddress) {
        require(bytes(name).length <= 40 && bytes(symbol).length >= 2 && bytes(symbol).length <= 10 && bytes(imageURI).length <= 200, "BAD_METADATA");
        PumpToken token = new PumpToken(name, symbol, imageURI, address(this));
        ArcPumpCurve curve = new ArcPumpCurve(token, dexFactory, msg.sender, treasury, graduationThreshold);
        dexFactory.registerCurve(token, address(curve));
        require(token.transfer(address(curve), token.totalSupply()), "CURVE_ALLOCATION");
        uint256 id = ++launchCount; tokenByLaunch[id] = address(token); curveByLaunch[id] = address(curve);
        emit LaunchCreated(id, msg.sender, address(token), address(curve)); return (address(token), address(curve));
    }
}

/// @notice One-transaction deployment entry point for the complete Arc Pump stack.
contract ArcPumpSuite {
    ArcDexFactory public immutable dexFactory;
    ArcPumpFactory public immutable pumpFactory;
    uint256 public immutable graduationThreshold;
    address payable public immutable treasury;

    constructor(uint256 threshold_, address payable treasury_) {
        require(threshold_ > 1_000 ether && treasury_ != address(0), "BAD_CONFIG");
        ArcDexFactory dex = new ArcDexFactory(treasury_);
        ArcPumpFactory pump = new ArcPumpFactory(dex, treasury_, threshold_);
        dex.setPumpFactory(address(pump));
        dexFactory = dex;
        pumpFactory = pump;
        graduationThreshold = threshold_; treasury = treasury_;
    }
}

// src/ArcPair.sol

/// @notice Constant-product pair over two arbitrary ERC-20 tokens, with ERC-20
/// LP shares and a fee split 80% to liquidity providers / 20% to the protocol.
///
/// No owner, no withdraw, no pause, no upgrade. A provider's only exit is
/// removeLiquidity, in proportion to their shares.
///
/// SAFETY, and the reason this is not simply ArcFxPoolV2 with renamed variables:
/// pairs here hold tokens nobody vetted. A fee-on-transfer token delivers less
/// than the requested amount; a rebasing token changes balances with no transfer.
/// So reserves are NEVER updated from a caller-supplied amount. Every mutating
/// path performs its transfers and then calls _sync(), which derives reserves
/// from measured balances less accrued protocol fees. Swap output is computed
/// from the amount actually RECEIVED, not the amount requested.
contract ArcPair {
    // --- ERC-20 LP shares ---
    string public constant name = "Arc LP";
    string public constant symbol = "ARC-LP";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    // --- Pair ---
    IERC20 public immutable token0;
    IERC20 public immutable token1;
    address public immutable treasury;
    /// @dev Total swap fee. 10 (stable) or 30 (volatile); immutable per pair.
    uint16 public immutable feeBps;

    uint256 public constant MINIMUM_LIQUIDITY = 1000;
    /// @dev Protocol takes 20% of the swap fee; providers keep 80%.
    uint16 public constant PROTOCOL_SHARE_PCT = 20;

    uint256 public reserve0;
    uint256 public reserve1;
    /// @dev Accrued protocol fees, held but excluded from reserves.
    uint256 public protocol0;
    uint256 public protocol1;

    bool private locked;

    event LiquidityAdded(address indexed provider, uint256 amount0, uint256 amount1, uint256 shares);
    event LiquidityRemoved(address indexed provider, uint256 amount0, uint256 amount1, uint256 shares);
    event Swapped(address indexed trader, bool zeroForOne, uint256 amountIn, uint256 amountOut, uint256 protocolFee);
    event ProtocolFeesSwept(address indexed to, uint256 amount0, uint256 amount1);

    modifier nonReentrant() {
        require(!locked, "REENTRANCY");
        locked = true;
        _;
        locked = false;
    }

    constructor(IERC20 token0_, IERC20 token1_, uint16 feeBps_, address treasury_) {
        require(address(token0_) != address(0) && address(token1_) != address(0), "ZERO_ADDRESS");
        require(feeBps_ == 10 || feeBps_ == 30, "BAD_FEE_TIER");
        require(address(token0_) < address(token1_), "UNORDERED");
        require(treasury_ != address(0), "ZERO_TREASURY");
        token0 = token0_;
        token1 = token1_;
        feeBps = feeBps_;
        treasury = treasury_;
    }

    function protocolFeeBps() public view returns (uint256) {
        return uint256(feeBps) * PROTOCOL_SHARE_PCT / 100;
    }

    function lpFeeBps() public view returns (uint256) {
        return uint256(feeBps) - protocolFeeBps();
    }

    // --- Liquidity ---

    function addLiquidity(uint256 amount0, uint256 amount1, uint256 minShares, uint64 deadline)
        external
        nonReentrant
        returns (uint256 shares)
    {
        require(block.timestamp <= deadline, "EXPIRED");
        require(amount0 > 0 && amount1 > 0, "ZERO_AMOUNT");

        // Measure what actually arrives — a fee-on-transfer token delivers less.
        uint256 received0 = _pull(token0, amount0);
        uint256 received1 = _pull(token1, amount1);
        require(received0 > 0 && received1 > 0, "NOTHING_RECEIVED");

        if (totalSupply == 0) {
            shares = _sqrt(received0 * received1);
            require(shares > MINIMUM_LIQUIDITY, "MIN_LIQUIDITY");
            shares -= MINIMUM_LIQUIDITY;
            _mint(address(0), MINIMUM_LIQUIDITY);
        } else {
            uint256 by0 = received0 * totalSupply / reserve0;
            uint256 by1 = received1 * totalSupply / reserve1;
            shares = by0 < by1 ? by0 : by1;
        }
        require(shares > 0 && shares >= minShares, "SLIPPAGE");

        _mint(msg.sender, shares);
        _sync();

        emit LiquidityAdded(msg.sender, received0, received1, shares);
    }

    function removeLiquidity(uint256 shares, uint256 min0, uint256 min1, uint64 deadline)
        external
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        require(block.timestamp <= deadline, "EXPIRED");
        require(shares > 0 && balanceOf[msg.sender] >= shares, "BAD_SHARES");

        amount0 = shares * reserve0 / totalSupply;
        amount1 = shares * reserve1 / totalSupply;
        require(amount0 > 0 && amount1 > 0, "ZERO_OUT");
        require(amount0 >= min0 && amount1 >= min1, "SLIPPAGE");

        _burn(msg.sender, shares);
        require(token0.transfer(msg.sender, amount0), "T0_OUT");
        require(token1.transfer(msg.sender, amount1), "T1_OUT");
        _sync();

        emit LiquidityRemoved(msg.sender, amount0, amount1, shares);
    }

    // --- Swap ---

    /// @notice Estimated output. Accurate for well-behaved tokens; a
    /// fee-on-transfer input token will deliver less than `amountIn`, so the
    /// executed swap computes from the measured receipt instead. Callers must
    /// rely on `minOut`, not on this figure, for safety.
    function quote(bool zeroForOne, uint256 amountIn) public view returns (uint256) {
        if (amountIn == 0 || reserve0 == 0 || reserve1 == 0) return 0;
        return _outFor(zeroForOne, amountIn);
    }

    function _outFor(bool zeroForOne, uint256 amountIn) private view returns (uint256) {
        uint256 protocolFee = amountIn * protocolFeeBps() / 10_000;
        uint256 netIn = amountIn - protocolFee;
        (uint256 reserveIn, uint256 reserveOut) = zeroForOne ? (reserve0, reserve1) : (reserve1, reserve0);
        uint256 inWithFee = netIn * (10_000 - lpFeeBps());
        return reserveOut * inWithFee / (reserveIn * 10_000 + inWithFee);
    }

    function swap(bool zeroForOne, uint256 amountIn, uint256 minOut, uint64 deadline)
        external
        nonReentrant
        returns (uint256 out)
    {
        require(block.timestamp <= deadline, "EXPIRED");
        require(amountIn > 0 && reserve0 > 0 && reserve1 > 0, "BAD_SWAP");

        (IERC20 tokenIn, IERC20 tokenOut) = zeroForOne ? (token0, token1) : (token1, token0);

        // Compute from what actually arrived, not what was asked for.
        uint256 receivedIn = _pull(tokenIn, amountIn);
        require(receivedIn > 0, "NOTHING_RECEIVED");

        out = _outFor(zeroForOne, receivedIn);
        require(out >= minOut && out > 0, "SLIPPAGE");

        uint256 protocolFee = receivedIn * protocolFeeBps() / 10_000;
        if (zeroForOne) protocol0 += protocolFee;
        else protocol1 += protocolFee;

        require(tokenOut.transfer(msg.sender, out), "TOKEN_OUT");
        _sync();

        emit Swapped(msg.sender, zeroForOne, receivedIn, out, protocolFee);
    }

    /// @notice Push accrued protocol fees to the immutable treasury. Callable by
    /// anyone, so a failing treasury transfer can never fail a user's swap.
    function sweepProtocolFees() external nonReentrant {
        uint256 a0 = protocol0;
        uint256 a1 = protocol1;
        protocol0 = 0;
        protocol1 = 0;
        if (a0 > 0) require(token0.transfer(treasury, a0), "T0_OUT");
        if (a1 > 0) require(token1.transfer(treasury, a1), "T1_OUT");
        _sync();
        emit ProtocolFeesSwept(treasury, a0, a1);
    }

    // --- Internals ---

    /// @dev Pull tokens and return the amount actually received.
    function _pull(IERC20 token, uint256 amount) private returns (uint256) {
        uint256 before = token.balanceOf(address(this));
        require(token.transferFrom(msg.sender, address(this), amount), "TOKEN_IN");
        return token.balanceOf(address(this)) - before;
    }

    /// @dev Reserves are always derived from real balances, never from requested
    /// amounts. Anything donated to the pair is absorbed into reserves and
    /// benefits all providers.
    function _sync() private {
        reserve0 = token0.balanceOf(address(this)) - protocol0;
        reserve1 = token1.balanceOf(address(this)) - protocol1;
    }

    // --- ERC-20 ---

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - value;
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) private {
        require(to != address(0), "ZERO_TO");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    function _mint(address to, uint256 value) private {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function _burn(address from, uint256 value) private {
        balanceOf[from] -= value;
        totalSupply -= value;
        emit Transfer(from, address(0), value);
    }

    function _sqrt(uint256 y) private pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }
}

// src/ArcPumpV7.sol

// V7 is identical to V6 (pull-based protocol fee vault) with one correction:
// ArcDexPairV7.sell now applies the same TOTAL_FEE_BPS (30 bps) swap haircut as
// buy, instead of the hardcoded 25 bps in V6. Fees remain symmetric buy/sell.

abstract contract PullFeeVault {
    address payable public immutable treasury;
    uint256 public accruedProtocolFees;
    bool internal feeLocked;
    event ProtocolFeeAccrued(uint256 amount, uint256 totalAccrued);
    event ProtocolFeesWithdrawn(address indexed treasury, uint256 amount);

    constructor(address payable treasury_) {
        require(treasury_ != address(0), "ZERO_TREASURY");
        treasury = treasury_;
    }

    function _accrueFee(uint256 amount) internal {
        accruedProtocolFees += amount;
        emit ProtocolFeeAccrued(amount, accruedProtocolFees);
    }

    function withdrawProtocolFees() external {
        require(msg.sender == treasury, "TREASURY_ONLY");
        require(!feeLocked, "REENTRANCY");
        feeLocked = true;
        uint256 amount = accruedProtocolFees;
        require(amount > 0, "NO_FEES");
        accruedProtocolFees = 0;
        (bool ok,) = treasury.call{value: amount}("");
        require(ok, "WITHDRAW_FAILED");
        feeLocked = false;
        emit ProtocolFeesWithdrawn(treasury, amount);
    }
}

contract ArcDexPairV7 is PullFeeVault {
    uint8 public constant ENGINE_VERSION = 7;
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;
    PumpToken public immutable token;
    address public immutable initializer;
    uint256 public constant TOTAL_FEE_BPS = 30;
    uint256 public constant PROTOCOL_FEE_BPS = 5;
    uint256 public tokenReserve;
    uint256 public nativeReserve;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    bool private locked;
    event LiquidityBurned(uint256 tokenAmount, uint256 nativeAmount, uint256 lpAmount);
    event Swap(address indexed trader, bool nativeToToken, uint256 amountIn, uint256 amountOut, uint256 protocolFee);
    modifier nonReentrant() {
        require(!locked && !feeLocked, "REENTRANCY");
        locked = true;
        feeLocked = true;
        _;
        feeLocked = false;
        locked = false;
    }

    constructor(PumpToken token_, address initializer_, address payable treasury_) PullFeeVault(treasury_) {
        require(address(token_) != address(0) && initializer_ != address(0), "ZERO_ADDRESS");
        token = token_;
        initializer = initializer_;
    }

    function initialize(uint256 tokenAmount) external payable nonReentrant {
        require(msg.sender == initializer && totalSupply == 0 && msg.value > 0 && tokenAmount > 0, "BAD_INIT");
        require(token.transferFrom(msg.sender, address(this), tokenAmount), "TOKEN_IN");
        tokenReserve = tokenAmount;
        nativeReserve = msg.value;
        uint256 lp = _sqrt(tokenAmount * msg.value);
        require(lp > 0, "ZERO_LP");
        totalSupply = lp;
        balanceOf[BURN] = lp;
        emit LiquidityBurned(tokenAmount, msg.value, lp);
    }

    function buy(uint256 minTokensOut, uint64 deadline) external payable nonReentrant returns (uint256 out) {
        require(block.timestamp <= deadline && msg.value > 0 && totalSupply > 0, "BAD_SWAP");
        uint256 inWithFee = msg.value * (10_000 - TOTAL_FEE_BPS);
        out = tokenReserve * inWithFee / (nativeReserve * 10_000 + inWithFee);
        require(out >= minTokensOut && out > 0, "SLIPPAGE");
        uint256 fee = msg.value * PROTOCOL_FEE_BPS / 10_000;
        nativeReserve += msg.value - fee;
        tokenReserve -= out;
        _accrueFee(fee);
        require(token.transfer(msg.sender, out), "TOKEN_OUT");
        emit Swap(msg.sender, true, msg.value, out, fee);
    }

    function sell(uint256 tokenIn, uint256 minNativeOut, uint64 deadline) external nonReentrant returns (uint256 out) {
        require(block.timestamp <= deadline && tokenIn > 0 && totalSupply > 0, "BAD_SWAP");
        uint256 inWithFee = tokenIn * (10_000 - TOTAL_FEE_BPS);
        uint256 grossOut = nativeReserve * inWithFee / (tokenReserve * 10_000 + inWithFee);
        uint256 fee = grossOut * PROTOCOL_FEE_BPS / 10_000;
        out = grossOut - fee;
        require(out >= minNativeOut && out > 0, "SLIPPAGE");
        require(token.transferFrom(msg.sender, address(this), tokenIn), "TOKEN_IN");
        tokenReserve += tokenIn;
        nativeReserve -= grossOut;
        _accrueFee(fee);
        (bool ok,) = msg.sender.call{value: out}("");
        require(ok, "NATIVE_OUT");
        emit Swap(msg.sender, false, tokenIn, out, fee);
    }

    function _sqrt(uint256 y) private pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }
}

contract ArcDexFactoryV7 {
    uint8 public constant ENGINE_VERSION = 7;
    address public immutable owner;
    address payable public immutable treasury;
    address public pumpFactory;
    mapping(address => address) public pairFor;
    mapping(address => address) public curveFor;
    event PairCreated(address indexed token, address indexed pair, address indexed initializer);

    constructor(address payable treasury_) {
        require(treasury_ != address(0), "ZERO_ADDRESS");
        owner = msg.sender;
        treasury = treasury_;
    }

    function setPumpFactory(address value) external {
        require(msg.sender == owner && pumpFactory == address(0) && value != address(0), "NOT_AUTHORIZED");
        pumpFactory = value;
    }

    function registerCurve(PumpToken token, address curve) external {
        require(
            msg.sender == pumpFactory && curveFor[address(token)] == address(0) && curve != address(0), "NOT_AUTHORIZED"
        );
        curveFor[address(token)] = curve;
    }

    function createPair(PumpToken token, address initializer) external returns (ArcDexPairV7 pair) {
        require(msg.sender == initializer && curveFor[address(token)] == initializer, "NOT_AUTHORIZED");
        require(pairFor[address(token)] == address(0), "PAIR_EXISTS");
        pair = new ArcDexPairV7(token, initializer, treasury);
        pairFor[address(token)] = address(pair);
        emit PairCreated(address(token), address(pair), initializer);
    }
}

contract ArcPumpCurveV7 is PullFeeVault {
    uint8 public constant ENGINE_VERSION = 7;
    PumpToken public immutable token;
    ArcDexFactoryV7 public immutable dexFactory;
    address public immutable creator;
    uint256 public constant CURVE_FEE_BPS = 100;
    uint256 public immutable graduationThreshold;
    uint256 public constant VIRTUAL_NATIVE = 1_000 ether;
    uint256 public realNativeReserve;
    bool public graduated;
    ArcDexPairV7 public pair;
    bool private locked;
    event Bought(address indexed buyer, uint256 nativeIn, uint256 tokensOut, uint256 protocolFee);
    event Sold(address indexed seller, uint256 tokensIn, uint256 nativeOut, uint256 protocolFee);
    event Graduated(address indexed pair, uint256 tokenLiquidity, uint256 nativeLiquidity, address lpBurnAddress);
    modifier nonReentrant() {
        require(!locked && !feeLocked, "REENTRANCY");
        locked = true;
        feeLocked = true;
        _;
        feeLocked = false;
        locked = false;
    }

    constructor(PumpToken token_, ArcDexFactoryV7 dex_, address creator_, address payable treasury_, uint256 threshold_)
        PullFeeVault(treasury_)
    {
        require(
            address(token_) != address(0) && address(dex_) != address(0) && creator_ != address(0)
                && threshold_ > VIRTUAL_NATIVE,
            "BAD_INIT"
        );
        token = token_;
        dexFactory = dex_;
        creator = creator_;
        graduationThreshold = threshold_;
    }

    function buy(uint256 minTokensOut, uint64 deadline) external payable nonReentrant returns (uint256 out) {
        require(!graduated && block.timestamp <= deadline && msg.value > 0, "CURVE_CLOSED");
        uint256 fee = msg.value * CURVE_FEE_BPS / 10_000;
        uint256 netIn = msg.value - fee;
        uint256 inventory = token.balanceOf(address(this));
        uint256 x = VIRTUAL_NATIVE + realNativeReserve;
        out = inventory - (x * inventory / (x + netIn));
        require(out >= minTokensOut && out > 0, "SLIPPAGE");
        realNativeReserve += netIn;
        _accrueFee(fee);
        require(token.transfer(msg.sender, out), "TOKEN_OUT");
        emit Bought(msg.sender, msg.value, out, fee);
        if (realNativeReserve >= graduationThreshold) _graduate();
    }

    function sell(uint256 tokenIn, uint256 minNativeOut, uint64 deadline) external nonReentrant returns (uint256 out) {
        require(!graduated && block.timestamp <= deadline && tokenIn > 0, "CURVE_CLOSED");
        uint256 inventory = token.balanceOf(address(this));
        uint256 x = VIRTUAL_NATIVE + realNativeReserve;
        uint256 grossOut = x - (x * inventory / (inventory + tokenIn));
        if (grossOut > realNativeReserve) grossOut = realNativeReserve;
        uint256 fee = grossOut * CURVE_FEE_BPS / 10_000;
        out = grossOut - fee;
        require(out >= minNativeOut && out > 0, "SLIPPAGE");
        require(token.transferFrom(msg.sender, address(this), tokenIn), "TOKEN_IN");
        realNativeReserve -= grossOut;
        _accrueFee(fee);
        (bool ok,) = msg.sender.call{value: out}("");
        require(ok, "NATIVE_OUT");
        emit Sold(msg.sender, tokenIn, out, fee);
    }

    function _graduate() private {
        graduated = true;
        uint256 tokenLiquidity = token.balanceOf(address(this));
        uint256 nativeLiquidity = realNativeReserve;
        realNativeReserve = 0;
        pair = dexFactory.createPair(token, address(this));
        require(token.approve(address(pair), tokenLiquidity), "APPROVE");
        pair.initialize{value: nativeLiquidity}(tokenLiquidity);
        emit Graduated(address(pair), tokenLiquidity, nativeLiquidity, pair.BURN());
    }
}

contract ArcPumpFactoryV7 {
    uint8 public constant ENGINE_VERSION = 7;
    ArcDexFactoryV7 public immutable dexFactory;
    uint256 public immutable graduationThreshold;
    address payable public immutable treasury;
    uint256 public launchCount;
    mapping(uint256 => address) public tokenByLaunch;
    mapping(uint256 => address) public curveByLaunch;
    event LaunchCreated(uint256 indexed id, address indexed creator, address token, address curve);

    constructor(ArcDexFactoryV7 dex_, address payable treasury_, uint256 threshold_) {
        require(address(dex_) != address(0) && treasury_ != address(0) && threshold_ > 1_000 ether, "BAD_CONFIG");
        dexFactory = dex_;
        treasury = treasury_;
        graduationThreshold = threshold_;
    }

    function createLaunch(string calldata name, string calldata symbol, string calldata imageURI)
        external
        returns (address tokenAddress, address curveAddress)
    {
        require(
            bytes(name).length <= 40 && bytes(symbol).length >= 2 && bytes(symbol).length <= 10
                && bytes(imageURI).length <= 200,
            "BAD_METADATA"
        );
        PumpToken token = new PumpToken(name, symbol, imageURI, address(this));
        ArcPumpCurveV7 curve = new ArcPumpCurveV7(token, dexFactory, msg.sender, treasury, graduationThreshold);
        dexFactory.registerCurve(token, address(curve));
        require(token.transfer(address(curve), token.totalSupply()), "CURVE_ALLOCATION");
        uint256 id = ++launchCount;
        tokenByLaunch[id] = address(token);
        curveByLaunch[id] = address(curve);
        emit LaunchCreated(id, msg.sender, address(token), address(curve));
        return (address(token), address(curve));
    }
}

contract ArcPumpSuiteV7 {
    uint8 public constant ENGINE_VERSION = 7;
    ArcDexFactoryV7 public immutable dexFactory;
    ArcPumpFactoryV7 public immutable pumpFactory;
    uint256 public immutable graduationThreshold;
    address payable public immutable treasury;

    constructor(uint256 threshold_, address payable treasury_) {
        require(threshold_ > 1_000 ether && treasury_ != address(0), "BAD_CONFIG");
        ArcDexFactoryV7 dex = new ArcDexFactoryV7(treasury_);
        ArcPumpFactoryV7 pump = new ArcPumpFactoryV7(dex, treasury_, threshold_);
        dex.setPumpFactory(address(pump));
        dexFactory = dex;
        pumpFactory = pump;
        graduationThreshold = threshold_;
        treasury = treasury_;
    }
}

// src/ArcPairFactoryV2.sol

interface IGraduationAuthority {
    /// True while `token` belongs to a launch whose curve has not graduated.
    function isUngraduatedLaunchToken(address token) external view returns (bool);
    /// True if `account` is a curve this authority deployed.
    function isCurve(address account) external view returns (bool);
}

/// @notice Deploys and registers ArcPair markets.
///
/// Same as ArcPairFactory, plus one rule: while a launchpad token's curve is
/// still running, only that curve may open its pair.
///
/// Without that rule graduation is stealable. The pair address is fixed by
/// (token, quote, tier), so anyone could buy the token, create the pair first,
/// seed it at an absurd ratio, and wait. At graduation `addLiquidity` credits
/// `min(by0, by1)` — the curve would deposit both sides in full, be credited on
/// the bad ratio, and the difference would be absorbed into the pool and shared
/// with whoever already held shares. Refusing the deposit afterwards only turns
/// theft into griefing; refusing the *creation* removes the position entirely.
///
/// Ownership note: this contract has no owner, but `graduationAuthority` cannot
/// be an immutable, because the authority needs this factory's address in its
/// own constructor. It is set exactly once by the deployer and is permanently
/// frozen afterwards. Until it is set, no token is reserved and the factory
/// behaves exactly like the permissionless one.
contract ArcPairFactoryV2 {
    address public immutable treasury;
    address private immutable deployer;

    address public graduationAuthority;

    mapping(address => mapping(address => mapping(uint16 => address))) private pairs;
    address[] public allPairs;

    event PairCreated(address indexed token0, address indexed token1, uint16 feeBps, address pair);
    event GraduationAuthoritySet(address indexed authority);

    constructor(address treasury_) {
        require(treasury_ != address(0), "ZERO_TREASURY");
        treasury = treasury_;
        deployer = msg.sender;
    }

    /// One-time and self-locking. After this call the deployer has no remaining
    /// privilege of any kind over this contract.
    function setGraduationAuthority(address authority) external {
        require(msg.sender == deployer, "NOT_DEPLOYER");
        require(graduationAuthority == address(0), "ALREADY_SET");
        require(authority != address(0), "ZERO_AUTHORITY");
        graduationAuthority = authority;
        emit GraduationAuthoritySet(authority);
    }

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    function getPair(address tokenA, address tokenB, uint16 feeBps) public view returns (address) {
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return pairs[t0][t1][feeBps];
    }

    /// True while the token's pair may only be opened by its own curve.
    function isReserved(address token) public view returns (bool) {
        address authority = graduationAuthority;
        if (authority == address(0)) return false;
        // A malfunctioning authority must not be able to freeze pair creation
        // for every token, so a failed call is read as "not reserved".
        try IGraduationAuthority(authority).isUngraduatedLaunchToken(token) returns (bool reserved) {
            return reserved;
        } catch {
            return false;
        }
    }

    function createPair(address tokenA, address tokenB, uint16 feeBps) external returns (address pair) {
        require(!isReserved(tokenA) && !isReserved(tokenB), "RESERVED_UNTIL_GRADUATION");
        return _create(tokenA, tokenB, feeBps);
    }

    /// Graduation path. Callable only by a curve deployed by the authority, and
    /// only for its own token — a curve cannot open a pair for someone else's.
    function createGraduationPair(address tokenA, address tokenB, uint16 feeBps) external returns (address pair) {
        address authority = graduationAuthority;
        require(authority != address(0), "NO_AUTHORITY");
        require(IGraduationAuthority(authority).isCurve(msg.sender), "NOT_A_CURVE");
        return _create(tokenA, tokenB, feeBps);
    }

    function _create(address tokenA, address tokenB, uint16 feeBps) private returns (address pair) {
        require(tokenA != tokenB, "IDENTICAL");
        require(tokenA != address(0) && tokenB != address(0), "ZERO_ADDRESS");
        require(feeBps == 10 || feeBps == 30, "BAD_FEE_TIER");
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(pairs[t0][t1][feeBps] == address(0), "PAIR_EXISTS");

        pair = address(new ArcPair(IERC20(t0), IERC20(t1), feeBps, treasury));
        pairs[t0][t1][feeBps] = pair;
        allPairs.push(pair);

        emit PairCreated(t0, t1, feeBps, pair);
    }
}

// src/ArcPumpV8.sol

// V8 keeps V7's bonding curve exactly — same VIRTUAL_NATIVE, same 100 bps
// symmetric fee, same buy/sell math — and changes only where a curve graduates
// to. V7 graduated into ArcDexFactoryV7, a venue of its own. V8 graduates into
// ArcPair, so launched tokens land in the same pools third-party liquidity and
// routing already use.
//
// Graduation needs no wrapper. On Arc the gas token and the ERC-20 at
// USDC_ERC20 are two views of one balance, differing by 1e12 — verified on
// chain, not assumed. A curve holding native can approve the ERC-20 interface
// directly.

contract ArcPumpCurveV8 is PullFeeVault {
    uint8 public constant ENGINE_VERSION = 8;

    /// Dual-interface USDC: the gas token in 18 decimals, this ERC-20 in 6.
    address public constant USDC_ERC20 = 0x3600000000000000000000000000000000000000;
    uint256 public constant NATIVE_TO_UNIT_6 = 1e12;
    uint16 public constant GRADUATION_TIER = 30;
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    PumpToken public immutable token;
    ArcPairFactoryV2 public immutable pairFactory;
    address public immutable creator;
    uint256 public constant CURVE_FEE_BPS = 100;
    uint256 public immutable graduationThreshold;
    uint256 public constant VIRTUAL_NATIVE = 1_000 ether;
    uint256 public realNativeReserve;
    bool public graduated;
    ArcPair public pair;
    bool private locked;

    event Bought(address indexed buyer, uint256 nativeIn, uint256 tokensOut, uint256 protocolFee);
    event Sold(address indexed seller, uint256 tokensIn, uint256 nativeOut, uint256 protocolFee);
    event Graduated(address indexed pair, uint256 tokenLiquidity, uint256 usdcLiquidity, uint256 lpBurned);

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
        ArcPairFactoryV2 pairFactory_,
        address creator_,
        address payable treasury_,
        uint256 threshold_
    ) PullFeeVault(treasury_) {
        require(
            address(token_) != address(0) && address(pairFactory_) != address(0) && creator_ != address(0)
                && threshold_ > VIRTUAL_NATIVE,
            "BAD_INIT"
        );
        token = token_;
        pairFactory = pairFactory_;
        creator = creator_;
        graduationThreshold = threshold_;
    }

    function buy(uint256 minTokensOut, uint64 deadline) external payable nonReentrant returns (uint256 out) {
        require(!graduated && block.timestamp <= deadline && msg.value > 0, "CURVE_CLOSED");
        uint256 fee = msg.value * CURVE_FEE_BPS / 10_000;
        uint256 netIn = msg.value - fee;
        uint256 inventory = token.balanceOf(address(this));
        uint256 x = VIRTUAL_NATIVE + realNativeReserve;
        out = inventory - (x * inventory / (x + netIn));
        require(out >= minTokensOut && out > 0, "SLIPPAGE");
        realNativeReserve += netIn;
        _accrueFee(fee);
        require(token.transfer(msg.sender, out), "TOKEN_OUT");
        emit Bought(msg.sender, msg.value, out, fee);
        if (realNativeReserve >= graduationThreshold) _graduate();
    }

    function sell(uint256 tokenIn, uint256 minNativeOut, uint64 deadline) external nonReentrant returns (uint256 out) {
        require(!graduated && block.timestamp <= deadline && tokenIn > 0, "CURVE_CLOSED");
        uint256 inventory = token.balanceOf(address(this));
        uint256 x = VIRTUAL_NATIVE + realNativeReserve;
        uint256 grossOut = x - (x * inventory / (inventory + tokenIn));
        if (grossOut > realNativeReserve) grossOut = realNativeReserve;
        uint256 fee = grossOut * CURVE_FEE_BPS / 10_000;
        out = grossOut - fee;
        require(out >= minNativeOut && out > 0, "SLIPPAGE");
        require(token.transferFrom(msg.sender, address(this), tokenIn), "TOKEN_IN");
        realNativeReserve -= grossOut;
        _accrueFee(fee);
        (bool ok,) = msg.sender.call{value: out}("");
        require(ok, "NATIVE_OUT");
        emit Sold(msg.sender, tokenIn, out, fee);
    }

    function _graduate() private {
        graduated = true;

        uint256 tokenLiquidity = token.balanceOf(address(this));
        uint256 nativeLiquidity = realNativeReserve;
        realNativeReserve = 0;

        // Truncation leaves less than 0.000001 USDC with the curve permanently.
        uint256 usdcLiquidity = nativeLiquidity / NATIVE_TO_UNIT_6;
        require(tokenLiquidity > 0 && usdcLiquidity > 0, "NO_LIQUIDITY");

        // The factory reserves this pair for this curve while the curve runs,
        // so creation cannot have been front-run. Asserted anyway: if the pair
        // somehow exists already, its price is not ours to inherit.
        address pairAddress =
            pairFactory.createGraduationPair(address(token), USDC_ERC20, GRADUATION_TIER);
        pair = ArcPair(pairAddress);
        require(pair.totalSupply() == 0, "PAIR_ALREADY_SEEDED");

        require(token.approve(pairAddress, tokenLiquidity), "APPROVE_TOKEN");
        require(IERC20(USDC_ERC20).approve(pairAddress, usdcLiquidity), "APPROVE_USDC");

        (uint256 amount0, uint256 amount1) = address(token) < USDC_ERC20
            ? (tokenLiquidity, usdcLiquidity)
            : (usdcLiquidity, tokenLiquidity);

        uint256 shares = pair.addLiquidity(amount0, amount1, 1, uint64(block.timestamp));

        // Burn the LP so graduated liquidity can never be pulled out. ArcPair's
        // _transfer rejects address(0), so it goes to the dead address instead.
        require(pair.transfer(BURN, shares), "BURN_LP");

        emit Graduated(pairAddress, tokenLiquidity, usdcLiquidity, shares);
    }
}

contract ArcPumpFactoryV8 {
    uint8 public constant ENGINE_VERSION = 8;
    ArcPairFactoryV2 public immutable pairFactory;
    uint256 public immutable graduationThreshold;
    address payable public immutable treasury;

    uint256 public launchCount;
    mapping(uint256 => address) public tokenByLaunch;
    mapping(uint256 => address) public curveByLaunch;
    mapping(address => address) public curveForToken;
    mapping(address => bool) public isCurve;

    event LaunchCreated(uint256 indexed id, address indexed creator, address token, address curve);

    constructor(ArcPairFactoryV2 pairFactory_, address payable treasury_, uint256 threshold_) {
        require(address(pairFactory_) != address(0) && treasury_ != address(0) && threshold_ > 1_000 ether, "BAD_CONFIG");
        pairFactory = pairFactory_;
        treasury = treasury_;
        graduationThreshold = threshold_;
    }

    /// Read by ArcPairFactoryV2 to decide whether a token's pair is reserved.
    function isUngraduatedLaunchToken(address token) external view returns (bool) {
        address curve = curveForToken[token];
        if (curve == address(0)) return false;
        return !ArcPumpCurveV8(curve).graduated();
    }

    function createLaunch(string calldata name, string calldata symbol, string calldata imageURI)
        external
        returns (address tokenAddress, address curveAddress)
    {
        require(
            bytes(name).length <= 40 && bytes(symbol).length >= 2 && bytes(symbol).length <= 10
                && bytes(imageURI).length <= 200,
            "BAD_METADATA"
        );
        PumpToken token = new PumpToken(name, symbol, imageURI, address(this));
        ArcPumpCurveV8 curve = new ArcPumpCurveV8(token, pairFactory, msg.sender, treasury, graduationThreshold);
        require(token.transfer(address(curve), token.totalSupply()), "CURVE_ALLOCATION");

        uint256 id = ++launchCount;
        tokenByLaunch[id] = address(token);
        curveByLaunch[id] = address(curve);
        curveForToken[address(token)] = address(curve);
        isCurve[address(curve)] = true;

        emit LaunchCreated(id, msg.sender, address(token), address(curve));
        return (address(token), address(curve));
    }
}


// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

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

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


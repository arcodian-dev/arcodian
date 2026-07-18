// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./ArcFxPool.sol";

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

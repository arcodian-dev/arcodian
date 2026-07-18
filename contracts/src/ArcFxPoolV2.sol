// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./ArcFxPool.sol";

/// @notice Permissionless constant-product AMM for two 6-decimal stablecoins on
/// Arc: USDC (ERC-20 interface at 0x3600…) and EURC.
///
/// Anyone may add or remove liquidity and receives ERC-20 LP shares in return.
/// The 10 bps swap fee is split 8 bps to liquidity providers — retained in
/// reserves, so each share grows in value rather than accruing a claimable
/// balance — and 2 bps to the protocol, accrued separately and swept to an
/// immutable treasury by a permissionless call.
///
/// There is deliberately no owner, no withdraw, no pause and no upgrade path.
/// A provider's only exit is removeLiquidity, in proportion to their shares,
/// and that is true for every holder including the deployer. This property is
/// the reason external liquidity can exist here at all; the v1 pool's
/// owner-only withdraw is why it never attracted any.
contract ArcFxPoolV2 {
    // --- ERC-20 LP shares ---
    string public constant name = "Arcodian FX LP";
    string public constant symbol = "ARC-FX-LP";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    // --- Pool ---
    IERC20 public immutable usdc;
    IERC20 public immutable eurc;
    address public immutable treasury;

    uint256 public constant LP_FEE_BPS = 8;
    uint256 public constant PROTOCOL_FEE_BPS = 2;
    /// @dev Locked forever at first deposit so a first provider cannot take a
    /// negligible share, donate to the pool, and round later providers to zero.
    uint256 public constant MINIMUM_LIQUIDITY = 1000;

    uint256 public reserveUsdc;
    uint256 public reserveEurc;
    /// @dev Accrued protocol fees. Held by the contract but NOT part of reserves,
    /// so they never back LP shares and never affect the price.
    uint256 public protocolUsdc;
    uint256 public protocolEurc;

    bool private locked;

    event LiquidityAdded(address indexed provider, uint256 usdcAmount, uint256 eurcAmount, uint256 shares);
    event LiquidityRemoved(address indexed provider, uint256 usdcAmount, uint256 eurcAmount, uint256 shares);
    event Swapped(address indexed trader, bool usdcToEurc, uint256 amountIn, uint256 amountOut, uint256 protocolFee);
    event ProtocolFeesSwept(address indexed to, uint256 usdcAmount, uint256 eurcAmount);

    modifier nonReentrant() {
        require(!locked, "REENTRANCY");
        locked = true;
        _;
        locked = false;
    }

    constructor(IERC20 usdc_, IERC20 eurc_, address treasury_) {
        require(
            address(usdc_) != address(0) && address(eurc_) != address(0) && treasury_ != address(0), "ZERO_ADDRESS"
        );
        usdc = usdc_;
        eurc = eurc_;
        treasury = treasury_;
    }

    // --- Liquidity ---

    function addLiquidity(uint256 usdcAmount, uint256 eurcAmount, uint256 minShares, uint64 deadline)
        external
        nonReentrant
        returns (uint256 shares)
    {
        require(block.timestamp <= deadline, "EXPIRED");
        require(usdcAmount > 0 && eurcAmount > 0, "ZERO_AMOUNT");

        if (totalSupply == 0) {
            shares = _sqrt(usdcAmount * eurcAmount);
            require(shares > MINIMUM_LIQUIDITY, "MIN_LIQUIDITY");
            shares -= MINIMUM_LIQUIDITY;
            _mint(address(0), MINIMUM_LIQUIDITY);
        } else {
            uint256 byUsdc = usdcAmount * totalSupply / reserveUsdc;
            uint256 byEurc = eurcAmount * totalSupply / reserveEurc;
            // Mint on the limiting side; any excess is donated to the pool.
            shares = byUsdc < byEurc ? byUsdc : byEurc;
        }
        require(shares > 0 && shares >= minShares, "SLIPPAGE");

        require(usdc.transferFrom(msg.sender, address(this), usdcAmount), "USDC_IN");
        require(eurc.transferFrom(msg.sender, address(this), eurcAmount), "EURC_IN");
        reserveUsdc += usdcAmount;
        reserveEurc += eurcAmount;
        _mint(msg.sender, shares);

        emit LiquidityAdded(msg.sender, usdcAmount, eurcAmount, shares);
    }

    function removeLiquidity(uint256 shares, uint256 minUsdc, uint256 minEurc, uint64 deadline)
        external
        nonReentrant
        returns (uint256 usdcOut, uint256 eurcOut)
    {
        require(block.timestamp <= deadline, "EXPIRED");
        require(shares > 0 && balanceOf[msg.sender] >= shares, "BAD_SHARES");

        usdcOut = shares * reserveUsdc / totalSupply;
        eurcOut = shares * reserveEurc / totalSupply;
        require(usdcOut > 0 && eurcOut > 0, "ZERO_OUT");
        require(usdcOut >= minUsdc && eurcOut >= minEurc, "SLIPPAGE");

        _burn(msg.sender, shares);
        reserveUsdc -= usdcOut;
        reserveEurc -= eurcOut;
        require(usdc.transfer(msg.sender, usdcOut), "USDC_OUT");
        require(eurc.transfer(msg.sender, eurcOut), "EURC_OUT");

        emit LiquidityRemoved(msg.sender, usdcOut, eurcOut, shares);
    }

    // --- Swap ---

    /// @notice Output for a given input, with both fee legs applied — so the
    /// quoted rate is the rate actually received.
    function quote(bool usdcToEurc, uint256 amountIn) public view returns (uint256 out) {
        if (amountIn == 0 || reserveUsdc == 0 || reserveEurc == 0) return 0;
        uint256 protocolFee = amountIn * PROTOCOL_FEE_BPS / 10_000;
        uint256 netIn = amountIn - protocolFee;
        (uint256 reserveIn, uint256 reserveOut) = usdcToEurc ? (reserveUsdc, reserveEurc) : (reserveEurc, reserveUsdc);
        uint256 inWithFee = netIn * (10_000 - LP_FEE_BPS);
        out = reserveOut * inWithFee / (reserveIn * 10_000 + inWithFee);
    }

    function swap(bool usdcToEurc, uint256 amountIn, uint256 minOut, uint64 deadline)
        external
        nonReentrant
        returns (uint256 out)
    {
        require(block.timestamp <= deadline, "EXPIRED");
        require(amountIn > 0 && reserveUsdc > 0 && reserveEurc > 0, "BAD_SWAP");
        out = quote(usdcToEurc, amountIn);
        require(out >= minOut && out > 0, "SLIPPAGE");

        uint256 protocolFee = amountIn * PROTOCOL_FEE_BPS / 10_000;
        uint256 netIn = amountIn - protocolFee;
        (IERC20 tokenIn, IERC20 tokenOut) = usdcToEurc ? (usdc, eurc) : (eurc, usdc);
        require(tokenIn.transferFrom(msg.sender, address(this), amountIn), "TOKEN_IN");

        if (usdcToEurc) {
            reserveUsdc += netIn;
            reserveEurc -= out;
            protocolUsdc += protocolFee;
        } else {
            reserveEurc += netIn;
            reserveUsdc -= out;
            protocolEurc += protocolFee;
        }
        require(tokenOut.transfer(msg.sender, out), "TOKEN_OUT");

        emit Swapped(msg.sender, usdcToEurc, amountIn, out, protocolFee);
    }

    /// @notice Push accrued protocol fees to the immutable treasury. Callable by
    /// anyone: a pull-style payout keeps a failing treasury transfer from ever
    /// failing an unrelated user's swap.
    function sweepProtocolFees() external nonReentrant {
        uint256 u = protocolUsdc;
        uint256 e = protocolEurc;
        protocolUsdc = 0;
        protocolEurc = 0;
        if (u > 0) require(usdc.transfer(treasury, u), "USDC_OUT");
        if (e > 0) require(eurc.transfer(treasury, e), "EURC_OUT");
        emit ProtocolFeesSwept(treasury, u, e);
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

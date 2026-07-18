// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

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

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20SwapFee {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IUniswapV3SwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external returns (uint256 amountOut);
}

/// @title ArcSwapFeeRouter
/// @notice Takes the disclosed Arcodian external-route fee and executes one V3 swap atomically.
/// @dev The treasury receives the fee only if the downstream swap succeeds.
contract ArcSwapFeeRouter {
    uint16 public constant FEE_BPS = 30;
    uint16 public constant BPS = 10_000;

    IUniswapV3SwapRouter public immutable swapRouter;
    address public immutable treasury;
    uint256 private unlocked = 1;

    error ZeroAddress();
    error InvalidAmount();
    error FeeConsumesAmount();
    error TokenTransferFailed();
    error Reentrancy();
    error Expired();
    error InvalidRecipient();

    event SwapExecuted(
        address indexed sender,
        address indexed tokenIn,
        address indexed tokenOut,
        uint24 poolFee,
        uint256 grossAmountIn,
        uint256 protocolFee,
        uint256 netAmountIn,
        uint256 amountOut,
        address recipient
    );

    modifier nonReentrant() {
        if (unlocked != 1) revert Reentrancy();
        unlocked = 2;
        _;
        unlocked = 1;
    }

    constructor(address swapRouter_, address treasury_) {
        if (swapRouter_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        swapRouter = IUniswapV3SwapRouter(swapRouter_);
        treasury = treasury_;
    }

    function quote(uint256 grossAmount) public pure returns (uint256 protocolFee, uint256 netAmount) {
        if (grossAmount == 0) revert InvalidAmount();
        protocolFee = (grossAmount * FEE_BPS + BPS - 1) / BPS;
        if (protocolFee >= grossAmount) revert FeeConsumesAmount();
        netAmount = grossAmount - protocolFee;
    }

    function swapExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24 poolFee,
        uint256 grossAmountIn,
        uint256 amountOutMinimum,
        uint256 deadline
    ) external nonReentrant returns (uint256 amountOut) {
        if (tokenIn == address(0) || tokenOut == address(0)) revert ZeroAddress();
        if (deadline < block.timestamp) revert Expired();
        (uint256 protocolFee, uint256 netAmount) = quote(grossAmountIn);

        if (!_transferFrom(tokenIn, msg.sender, treasury, protocolFee)) revert TokenTransferFailed();
        if (!_transferFrom(tokenIn, msg.sender, address(this), netAmount)) revert TokenTransferFailed();
        if (!_approve(tokenIn, address(swapRouter), 0)) revert TokenTransferFailed();
        if (!_approve(tokenIn, address(swapRouter), netAmount)) revert TokenTransferFailed();

        amountOut = swapRouter.exactInputSingle(
            IUniswapV3SwapRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: poolFee,
                recipient: msg.sender,
                amountIn: netAmount,
                amountOutMinimum: amountOutMinimum,
                sqrtPriceLimitX96: 0
            })
        );

        emit SwapExecuted(
            msg.sender, tokenIn, tokenOut, poolFee, grossAmountIn, protocolFee, netAmount, amountOut, msg.sender
        );
    }

    function _transferFrom(address token, address from, address to, uint256 amount) private returns (bool) {
        return IERC20SwapFee(token).transferFrom(from, to, amount);
    }

    function _approve(address token, address spender, uint256 amount) private returns (bool) {
        return IERC20SwapFee(token).approve(spender, amount);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {ArcSwapFeeRouter, IUniswapV3SwapRouter} from "../src/ArcSwapFeeRouter.sol";

contract MockSwapToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockV3Router {
    MockSwapToken public immutable input;
    MockSwapToken public immutable output;
    uint256 public lastAmountIn;
    address public lastRecipient;

    constructor(MockSwapToken input_, MockSwapToken output_) {
        input = input_;
        output = output_;
    }

    function exactInputSingle(IUniswapV3SwapRouter.ExactInputSingleParams calldata params)
        external
        returns (uint256 amountOut)
    {
        require(params.tokenIn == address(input) && params.tokenOut == address(output), "TOKENS");
        input.transferFrom(msg.sender, address(this), params.amountIn);
        amountOut = params.amountIn * 2;
        require(amountOut >= params.amountOutMinimum, "SLIPPAGE");
        output.transfer(params.recipient, amountOut);
        lastAmountIn = params.amountIn;
        lastRecipient = params.recipient;
    }
}

contract ArcSwapFeeRouterTest is Test {
    MockSwapToken input;
    MockSwapToken output;
    MockV3Router v3;
    ArcSwapFeeRouter router;
    address user = address(0xA11CE);
    address treasury = address(0xFEE);

    function setUp() public {
        input = new MockSwapToken();
        output = new MockSwapToken();
        v3 = new MockV3Router(input, output);
        router = new ArcSwapFeeRouter(address(v3), treasury);
        input.mint(user, 1_000_000);
        output.mint(address(v3), 2_000_000);
        vm.prank(user);
        input.approve(address(router), type(uint256).max);
    }

    function testSplitsFeeAndSwapsNetAmountAtomically() public {
        vm.prank(user);
        uint256 amountOut = router.swapExactInputSingle(
            address(input), address(output), 10_000, 1_000_000, 190_000, block.timestamp + 600
        );
        assertEq(amountOut, 1_994_000);
        assertEq(input.balanceOf(treasury), 3_000);
        assertEq(v3.lastAmountIn(), 997_000);
        assertEq(output.balanceOf(user), 1_994_000);
        assertEq(input.balanceOf(address(router)), 0);
    }

    function testRevertsWithoutKeepingFeeWhenSwapFailsSlippage() public {
        vm.prank(user);
        vm.expectRevert("SLIPPAGE");
        router.swapExactInputSingle(
            address(input), address(output), 10_000, 1_000_000, 2_000_000, block.timestamp + 600
        );
        assertEq(input.balanceOf(treasury), 0);
        assertEq(input.balanceOf(user), 1_000_000);
    }
}

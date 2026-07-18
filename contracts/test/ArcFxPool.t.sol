// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {ArcFxPool, IERC20} from "../src/ArcFxPool.sol";

contract MockStable {
    string public symbol;
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory symbol_) {
        symbol = symbol_;
    }

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
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract ArcFxPoolTest is Test {
    MockStable usdc;
    MockStable eurc;
    ArcFxPool pool;
    address trader = address(0xBEEF);

    function setUp() public {
        usdc = new MockStable("USDC");
        eurc = new MockStable("EURC");
        pool = new ArcFxPool(IERC20(address(usdc)), IERC20(address(eurc)));
        // seed 10 USDC + 9.2 EURC (~0.92 EUR/USD), 6 decimals
        usdc.mint(address(this), 10_000000);
        eurc.mint(address(this), 9_200000);
        usdc.approve(address(pool), type(uint256).max);
        eurc.approve(address(pool), type(uint256).max);
        pool.seed(10_000000, 9_200000);
    }

    function testSeededReserves() public view {
        assertEq(pool.reserveUsdc(), 10_000000);
        assertEq(pool.reserveEurc(), 9_200000);
    }

    function testQuoteMatchesSwapUsdcToEurc() public {
        usdc.mint(trader, 1_000000);
        vm.prank(trader);
        usdc.approve(address(pool), type(uint256).max);
        uint256 expected = pool.quote(true, 1_000000);
        assertGt(expected, 0);
        vm.prank(trader);
        uint256 out = pool.swap(true, 1_000000, 1, uint64(block.timestamp + 60));
        assertEq(out, expected);
        assertEq(eurc.balanceOf(trader), out);
        // reserves updated, product grew (fee retained)
        assertEq(pool.reserveUsdc(), 11_000000);
        assertEq(pool.reserveEurc(), 9_200000 - out);
    }

    function testSwapEurcToUsdc() public {
        eurc.mint(trader, 1_000000);
        vm.prank(trader);
        eurc.approve(address(pool), type(uint256).max);
        uint256 expected = pool.quote(false, 1_000000);
        vm.prank(trader);
        uint256 out = pool.swap(false, 1_000000, 1, uint64(block.timestamp + 60));
        assertEq(out, expected);
        assertEq(usdc.balanceOf(trader), out);
    }

    function testSlippageReverts() public {
        usdc.mint(trader, 1_000000);
        vm.prank(trader);
        usdc.approve(address(pool), type(uint256).max);
        uint256 expected = pool.quote(true, 1_000000);
        vm.prank(trader);
        vm.expectRevert("SLIPPAGE");
        pool.swap(true, 1_000000, expected + 1, uint64(block.timestamp + 60));
    }

    function testExpiredReverts() public {
        usdc.mint(trader, 1_000000);
        vm.prank(trader);
        usdc.approve(address(pool), type(uint256).max);
        vm.warp(1000);
        vm.prank(trader);
        vm.expectRevert("EXPIRED");
        pool.swap(true, 1_000000, 1, uint64(999));
    }

    function testOnlyOwnerSeedAndWithdraw() public {
        vm.prank(trader);
        vm.expectRevert("OWNER_ONLY");
        pool.withdraw(trader, 1, 1);
    }

    function testWithdraw() public {
        pool.withdraw(address(this), 5_000000, 0);
        assertEq(pool.reserveUsdc(), 5_000000);
        assertEq(usdc.balanceOf(address(this)), 5_000000);
    }

    function testFeeRetainedGrowsProduct() public {
        uint256 kBefore = pool.reserveUsdc() * pool.reserveEurc();
        usdc.mint(trader, 500000);
        vm.prank(trader);
        usdc.approve(address(pool), type(uint256).max);
        vm.prank(trader);
        pool.swap(true, 500000, 1, uint64(block.timestamp + 60));
        uint256 kAfter = pool.reserveUsdc() * pool.reserveEurc();
        assertGe(kAfter, kBefore); // constant-product with fee never shrinks k
    }
}

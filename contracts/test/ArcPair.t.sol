// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {ArcPair} from "../src/ArcPair.sol";
import {IERC20} from "../src/ArcFxPool.sol";

contract MockToken {
    string public symbol;
    uint8 public decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory symbol_, uint8 decimals_) {
        symbol = symbol_;
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }

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

contract ArcPairTest is Test {
    MockToken tokenA;
    MockToken tokenB;
    ArcPair pair;

    address treasury = address(0xFEE);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    uint64 constant DEADLINE = 4102444800;
    uint16 constant VOLATILE_BPS = 30;

    function setUp() public {
        tokenA = new MockToken("AAA", 18);
        tokenB = new MockToken("BBB", 18);
        (address t0, address t1) = address(tokenA) < address(tokenB)
            ? (address(tokenA), address(tokenB))
            : (address(tokenB), address(tokenA));
        pair = new ArcPair(IERC20(t0), IERC20(t1), VOLATILE_BPS, treasury);
        _fund(alice);
        _fund(bob);
    }

    function _fund(address who) internal {
        tokenA.mint(who, 1_000_000 ether);
        tokenB.mint(who, 1_000_000 ether);
        vm.startPrank(who);
        tokenA.approve(address(pair), type(uint256).max);
        tokenB.approve(address(pair), type(uint256).max);
        vm.stopPrank();
    }

    function _seed() internal returns (uint256 shares) {
        vm.prank(alice);
        shares = pair.addLiquidity(1000 ether, 1000 ether, 1, DEADLINE);
    }

    // --- Task 1: liquidity ---

    function testFirstDepositLocksMinimumLiquidity() public {
        uint256 shares = _seed();
        assertGt(shares, 0);
        assertEq(pair.balanceOf(address(0)), pair.MINIMUM_LIQUIDITY());
        assertEq(pair.reserve0(), 1000 ether);
        assertEq(pair.reserve1(), 1000 ether);
    }

    function testReservesAlwaysMatchMeasuredBalances() public {
        _seed();
        assertEq(pair.reserve0(), pair.token0().balanceOf(address(pair)) - pair.protocol0());
        assertEq(pair.reserve1(), pair.token1().balanceOf(address(pair)) - pair.protocol1());
    }

    function testSecondDepositIsProRata() public {
        uint256 aliceShares = _seed();
        vm.prank(bob);
        uint256 bobShares = pair.addLiquidity(500 ether, 500 ether, 1, DEADLINE);
        assertApproxEqRel(bobShares, aliceShares / 2, 1e15);
    }

    function testRemoveLiquidityReturnsPrincipal() public {
        uint256 shares = _seed();
        vm.prank(alice);
        (uint256 out0, uint256 out1) = pair.removeLiquidity(shares, 1, 1, DEADLINE);
        assertApproxEqRel(out0, 1000 ether, 1e15);
        assertApproxEqRel(out1, 1000 ether, 1e15);
    }

    function testFeeTierIsStoredAndSplitEightyTwenty() public view {
        assertEq(pair.feeBps(), VOLATILE_BPS);
        assertEq(pair.protocolFeeBps(), 6);
        assertEq(pair.lpFeeBps(), 24);
    }

    function testRejectsExpiredDeadline() public {
        vm.warp(1000);
        vm.prank(alice);
        vm.expectRevert(bytes("EXPIRED"));
        pair.addLiquidity(1 ether, 1 ether, 1, uint64(block.timestamp - 1));
    }

    // --- Task 2: swaps ---

    function testSwapSplitsFeeEightyTwenty() public {
        _seed();
        uint256 amountIn = 100 ether;
        vm.prank(bob);
        uint256 out = pair.swap(true, amountIn, 1, DEADLINE);

        assertGt(out, 0);
        assertEq(pair.protocol0(), amountIn * 6 / 10_000);
    }

    function testQuoteMatchesSwapForWellBehavedTokens() public {
        _seed();
        uint256 expected = pair.quote(true, 100 ether);
        vm.prank(bob);
        uint256 out = pair.swap(true, 100 ether, 1, DEADLINE);
        assertEq(out, expected);
    }

    function testShareValueGrowsWithTradingFees() public {
        uint256 shares = _seed();
        uint256 before = pair.reserve0() * 1e18 / pair.totalSupply();
        vm.startPrank(bob);
        uint256 got = pair.swap(true, 100 ether, 1, DEADLINE);
        pair.swap(false, got, 1, DEADLINE);
        vm.stopPrank();
        assertGt(pair.reserve0() * 1e18 / pair.totalSupply(), before);
        assertEq(pair.balanceOf(alice), shares, "share count unchanged");
    }

    function testSweepProtocolFeesIsPermissionless() public {
        _seed();
        vm.prank(bob);
        pair.swap(true, 100 ether, 1, DEADLINE);
        uint256 accrued = pair.protocol0();
        uint256 reserveBefore = pair.reserve0();

        vm.prank(address(0xDEAD));
        pair.sweepProtocolFees();

        assertEq(pair.token0().balanceOf(treasury), accrued);
        assertEq(pair.protocol0(), 0);
        assertEq(pair.reserve0(), reserveBefore, "reserves untouched");
    }

    function testStableTierChargesTenBps() public {
        (address t0, address t1) = address(tokenA) < address(tokenB)
            ? (address(tokenA), address(tokenB))
            : (address(tokenB), address(tokenA));
        ArcPair stable = new ArcPair(IERC20(t0), IERC20(t1), 10, treasury);
        assertEq(stable.protocolFeeBps(), 2);
        assertEq(stable.lpFeeBps(), 8);
    }

    function testSwapRejectsSlippage() public {
        _seed();
        vm.prank(bob);
        vm.expectRevert(bytes("SLIPPAGE"));
        pair.swap(true, 100 ether, type(uint128).max, DEADLINE);
    }

    function testConstructorRejectsUnorderedTokens() public {
        (address t0, address t1) = address(tokenA) < address(tokenB)
            ? (address(tokenA), address(tokenB))
            : (address(tokenB), address(tokenA));
        vm.expectRevert(bytes("UNORDERED"));
        new ArcPair(IERC20(t1), IERC20(t0), 30, treasury);
    }

    function testConstructorRejectsBadTier() public {
        (address t0, address t1) = address(tokenA) < address(tokenB)
            ? (address(tokenA), address(tokenB))
            : (address(tokenB), address(tokenA));
        vm.expectRevert(bytes("BAD_FEE_TIER"));
        new ArcPair(IERC20(t0), IERC20(t1), 25, treasury);
    }
}

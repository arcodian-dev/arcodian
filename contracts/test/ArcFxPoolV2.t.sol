// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {ArcFxPoolV2} from "../src/ArcFxPoolV2.sol";
import {IERC20} from "../src/ArcFxPool.sol";

contract MockStable {
    string public symbol;
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory symbol_) { symbol = symbol_; }

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

contract ArcFxPoolV2Test is Test {
    MockStable usdc;
    MockStable eurc;
    ArcFxPoolV2 pool;

    address treasury = address(0xFEE);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    uint64 constant DEADLINE = 4102444800; // 2100-01-01

    function setUp() public {
        usdc = new MockStable("USDC");
        eurc = new MockStable("EURC");
        pool = new ArcFxPoolV2(IERC20(address(usdc)), IERC20(address(eurc)), treasury);
        _fund(alice);
        _fund(bob);
    }

    function _fund(address who) internal {
        usdc.mint(who, 1_000_000_000000); // 1,000,000 USDC
        eurc.mint(who, 1_000_000_000000);
        vm.startPrank(who);
        usdc.approve(address(pool), type(uint256).max);
        eurc.approve(address(pool), type(uint256).max);
        vm.stopPrank();
    }

    /// Seed at the correct market rate: 1000 USDC : 920 EURC.
    function _seed() internal returns (uint256 shares) {
        vm.prank(alice);
        shares = pool.addLiquidity(1000_000000, 920_000000, 1, DEADLINE);
    }

    // --- Task 1: shares and liquidity ---

    function testFirstDepositLocksMinimumLiquidity() public {
        uint256 shares = _seed();
        assertGt(shares, 0, "alice got shares");
        assertEq(pool.balanceOf(alice), shares);
        assertEq(pool.balanceOf(address(0)), pool.MINIMUM_LIQUIDITY(), "minimum locked");
        assertEq(pool.totalSupply(), shares + pool.MINIMUM_LIQUIDITY());
        assertEq(pool.reserveUsdc(), 1000_000000);
        assertEq(pool.reserveEurc(), 920_000000);
    }

    function testSecondDepositIsProRata() public {
        uint256 aliceShares = _seed();
        vm.prank(bob);
        uint256 bobShares = pool.addLiquidity(500_000000, 460_000000, 1, DEADLINE);
        assertApproxEqRel(bobShares, aliceShares / 2, 1e15, "half the shares");
    }

    function testOffRatioDepositMintsOnTheLimitingSide() public {
        _seed();
        // 500 USDC pairs with 460 EURC at pool ratio; supplying 900 EURC donates the excess.
        vm.prank(bob);
        uint256 bobShares = pool.addLiquidity(500_000000, 900_000000, 1, DEADLINE);
        vm.prank(bob);
        (uint256 usdcOut, uint256 eurcOut) = pool.removeLiquidity(bobShares, 1, 1, DEADLINE);
        assertLt(usdcOut + eurcOut, 500_000000 + 900_000000, "excess was donated, not returned");
    }

    function testRemoveLiquidityReturnsPrincipal() public {
        uint256 shares = _seed();
        uint256 usdcBefore = usdc.balanceOf(alice);
        uint256 eurcBefore = eurc.balanceOf(alice);
        vm.prank(alice);
        (uint256 usdcOut, uint256 eurcOut) = pool.removeLiquidity(shares, 1, 1, DEADLINE);
        assertEq(usdc.balanceOf(alice), usdcBefore + usdcOut);
        assertEq(eurc.balanceOf(alice), eurcBefore + eurcOut);
        assertApproxEqRel(usdcOut, 1000_000000, 1e15);
        assertApproxEqRel(eurcOut, 920_000000, 1e15);
    }

    function testRejectsExpiredDeadline() public {
        vm.warp(1000);
        vm.prank(alice);
        vm.expectRevert(bytes("EXPIRED"));
        pool.addLiquidity(1000_000000, 920_000000, 1, uint64(block.timestamp - 1));
    }

    function testRejectsSharesBelowMinShares() public {
        _seed();
        vm.prank(bob);
        vm.expectRevert(bytes("SLIPPAGE"));
        pool.addLiquidity(1_000000, 1_000000, type(uint128).max, DEADLINE);
    }

    // --- Task 2: swaps and the fee split ---

    function testSwapSplitsFeeEightTwo() public {
        _seed();
        uint256 amountIn = 100_000000; // 100 USDC
        vm.prank(bob);
        uint256 out = pool.swap(true, amountIn, 1, DEADLINE);

        assertGt(out, 0, "bob received EURC");
        assertEq(pool.protocolUsdc(), 20000, "protocol accrued 2 bps");
        assertEq(pool.reserveUsdc(), 1000_000000 + (amountIn - 20000));
    }

    function testQuoteMatchesSwapOutput() public {
        _seed();
        uint256 expected = pool.quote(true, 100_000000);
        vm.prank(bob);
        uint256 out = pool.swap(true, 100_000000, 1, DEADLINE);
        assertEq(out, expected, "quote is the rate received");
    }

    function testShareValueGrowsWithTradingFees() public {
        uint256 shares = _seed();
        uint256 usdcPerShareBefore = pool.reserveUsdc() * 1e18 / pool.totalSupply();

        vm.startPrank(bob);
        uint256 got = pool.swap(true, 100_000000, 1, DEADLINE);
        pool.swap(false, got, 1, DEADLINE);
        vm.stopPrank();

        uint256 usdcPerShareAfter = pool.reserveUsdc() * 1e18 / pool.totalSupply();
        assertGt(usdcPerShareAfter, usdcPerShareBefore, "each share is worth more");
        assertEq(pool.balanceOf(alice), shares, "share count unchanged");
    }

    function testRemoveLiquidityReturnsPrincipalPlusFees() public {
        uint256 shares = _seed();
        vm.startPrank(bob);
        uint256 got = pool.swap(true, 100_000000, 1, DEADLINE);
        pool.swap(false, got, 1, DEADLINE);
        vm.stopPrank();

        vm.prank(alice);
        (uint256 usdcOut, uint256 eurcOut) = pool.removeLiquidity(shares, 1, 1, DEADLINE);
        assertGt(usdcOut + eurcOut, 1000_000000 + 920_000000 - 2, "principal plus fees");
    }

    function testSweepProtocolFeesIsPermissionlessAndMovesOnlyFees() public {
        _seed();
        vm.prank(bob);
        pool.swap(true, 100_000000, 1, DEADLINE);
        uint256 accrued = pool.protocolUsdc();
        uint256 reserveBefore = pool.reserveUsdc();

        vm.prank(address(0xDEAD));
        pool.sweepProtocolFees();

        assertEq(usdc.balanceOf(treasury), accrued, "treasury received the fees");
        assertEq(pool.protocolUsdc(), 0, "accrual cleared");
        assertEq(pool.reserveUsdc(), reserveBefore, "reserves untouched");
    }

    function testSwapRejectsSlippage() public {
        _seed();
        vm.prank(bob);
        vm.expectRevert(bytes("SLIPPAGE"));
        pool.swap(true, 100_000000, type(uint128).max, DEADLINE);
    }

    // --- Task 3: attacks and invariants ---

    /// The classic first-depositor attack: take a tiny share, donate directly to
    /// the pool, and round the next depositor's shares to zero.
    function testShareInflationAttackFails() public {
        vm.prank(alice);
        pool.addLiquidity(2_000000, 2_000000, 1, DEADLINE);

        vm.prank(alice);
        usdc.transfer(address(pool), 500_000000);

        vm.prank(bob);
        uint256 bobShares = pool.addLiquidity(100_000000, 100_000000, 1, DEADLINE);
        assertGt(bobShares, 0, "bob is not rounded to zero");

        vm.prank(bob);
        (uint256 usdcOut, uint256 eurcOut) = pool.removeLiquidity(bobShares, 1, 1, DEADLINE);
        assertGt(usdcOut + eurcOut, 0, "bob recovers value");
    }

    /// The deployer has no special power. This test contract deployed the pool.
    function testDeployerCannotWithdrawMoreThanItsShare() public {
        _seed();
        assertEq(pool.balanceOf(address(this)), 0, "deployer holds no shares");
        vm.expectRevert(bytes("BAD_SHARES"));
        pool.removeLiquidity(1, 1, 1, DEADLINE);
    }

    function testCannotRemoveMoreSharesThanHeld() public {
        uint256 shares = _seed();
        vm.prank(bob);
        vm.expectRevert(bytes("BAD_SHARES"));
        pool.removeLiquidity(shares, 1, 1, DEADLINE);
    }

    function testTwoProvidersSplitFeesProportionally() public {
        vm.prank(alice);
        uint256 aliceShares = pool.addLiquidity(1000_000000, 920_000000, 1, DEADLINE);
        vm.prank(bob);
        uint256 bobShares = pool.addLiquidity(1000_000000, 920_000000, 1, DEADLINE);

        address trader = address(0x7AAD);
        usdc.mint(trader, 500_000000);
        eurc.mint(trader, 500_000000);
        vm.startPrank(trader);
        usdc.approve(address(pool), type(uint256).max);
        eurc.approve(address(pool), type(uint256).max);
        uint256 got = pool.swap(true, 200_000000, 1, DEADLINE);
        pool.swap(false, got, 1, DEADLINE);
        vm.stopPrank();

        vm.prank(alice);
        (uint256 aliceUsdc, uint256 aliceEurc) = pool.removeLiquidity(aliceShares, 1, 1, DEADLINE);
        vm.prank(bob);
        (uint256 bobUsdc, uint256 bobEurc) = pool.removeLiquidity(bobShares, 1, 1, DEADLINE);

        assertApproxEqRel(aliceUsdc, bobUsdc, 1e15, "USDC split evenly");
        assertApproxEqRel(aliceEurc, bobEurc, 1e15, "EURC split evenly");
    }

    /// Protocol fees are held but never counted as reserves.
    function testProtocolFeesAreNotPartOfReserves() public {
        _seed();
        vm.prank(bob);
        pool.swap(true, 100_000000, 1, DEADLINE);
        assertEq(
            usdc.balanceOf(address(pool)),
            pool.reserveUsdc() + pool.protocolUsdc(),
            "held balance = reserves + accrued fees"
        );
    }

    function testFeeConstantsAreEightAndTwo() public view {
        assertEq(pool.LP_FEE_BPS(), 8);
        assertEq(pool.PROTOCOL_FEE_BPS(), 2);
    }
}

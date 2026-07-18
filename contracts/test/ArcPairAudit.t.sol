// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {ArcPair} from "../src/ArcPair.sol";
import {ArcPairFactory} from "../src/ArcPairFactory.sol";
import {ArcRouter} from "../src/ArcRouter.sol";
import {IERC20} from "../src/ArcFxPool.sol";

contract AuditToken {
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        uint256 x = allowance[f][msg.sender];
        if (x != type(uint256).max) allowance[f][msg.sender] = x - a;
        balanceOf[f] -= a; balanceOf[t] += a; return true;
    }
}

/// Skims on transfer. Used here as an intermediate hop, which is the case the
/// pair's own tests do not cover.
contract SkimToken {
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function _move(address f, address t, uint256 a) private {
        balanceOf[f] -= a;
        balanceOf[t] += a - (a / 100); // 1% vanishes
    }
    function transfer(address to, uint256 a) external returns (bool) { _move(msg.sender, to, a); return true; }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        uint256 x = allowance[f][msg.sender];
        if (x != type(uint256).max) allowance[f][msg.sender] = x - a;
        _move(f, t, a);
        return true;
    }
}

/// Adversarial cases found by re-reading ArcPair after it was written. Each one
/// is a hypothesis about how the contract could be broken, turned into a test so
/// the answer is evidence rather than opinion.
contract ArcPairAuditTest is Test {
    address treasury = address(0xFEE);
    address alice = address(0xA11CE);
    address attacker = address(0xBAD);
    uint64 constant DEADLINE = 4102444800;

    function _order(address a, address b) internal pure returns (address, address) {
        return a < b ? (a, b) : (b, a);
    }

    function _pairOf(address a, address b) internal returns (ArcPair) {
        (address t0, address t1) = _order(a, b);
        return new ArcPair(IERC20(t0), IERC20(t1), 30, treasury);
    }

    /// H1: donating tokens to an empty pair before the first deposit could skew
    /// the initial share calculation.
    function testDonationBeforeFirstDepositDoesNotBreakShares() public {
        AuditToken a = new AuditToken();
        AuditToken b = new AuditToken();
        ArcPair pair = _pairOf(address(a), address(b));

        a.mint(address(pair), 500 ether); // unsolicited donation into an empty pair
        a.mint(alice, 1000 ether);
        b.mint(alice, 1000 ether);

        vm.startPrank(alice);
        a.approve(address(pair), type(uint256).max);
        b.approve(address(pair), type(uint256).max);
        uint256 shares = pair.addLiquidity(1000 ether, 1000 ether, 1, DEADLINE);
        vm.stopPrank();

        assertGt(shares, 0, "first deposit still mints");
        assertEq(pair.reserve0(), pair.token0().balanceOf(address(pair)) - pair.protocol0());
        assertEq(pair.reserve1(), pair.token1().balanceOf(address(pair)) - pair.protocol1());
    }

    /// H2: withdrawing everything could drive a reserve to zero, after which
    /// addLiquidity divides by reserve0 and the pool is bricked.
    function testPoolStillUsableAfterEveryProviderExits() public {
        AuditToken a = new AuditToken();
        AuditToken b = new AuditToken();
        ArcPair pair = _pairOf(address(a), address(b));

        a.mint(alice, 10_000 ether);
        b.mint(alice, 10_000 ether);
        vm.startPrank(alice);
        a.approve(address(pair), type(uint256).max);
        b.approve(address(pair), type(uint256).max);
        uint256 shares = pair.addLiquidity(1000 ether, 1000 ether, 1, DEADLINE);
        pair.removeLiquidity(shares, 1, 1, DEADLINE);

        assertGt(pair.reserve0(), 0, "MINIMUM_LIQUIDITY keeps reserve0 non-zero");
        assertGt(pair.reserve1(), 0, "MINIMUM_LIQUIDITY keeps reserve1 non-zero");

        // The pool must still accept liquidity rather than dividing by zero.
        uint256 again = pair.addLiquidity(1000 ether, 1000 ether, 1, DEADLINE);
        vm.stopPrank();
        assertGt(again, 0, "pool is not bricked");
    }

    /// H3: a donation followed by a swap could let the donor extract more than
    /// they donated, since reserves are stale until _sync().
    function testDonateThenSwapDoesNotProfitTheDonor() public {
        AuditToken a = new AuditToken();
        AuditToken b = new AuditToken();
        ArcPair pair = _pairOf(address(a), address(b));
        bool aIsZero = address(a) < address(b);

        a.mint(alice, 10_000 ether);
        b.mint(alice, 10_000 ether);
        vm.startPrank(alice);
        a.approve(address(pair), type(uint256).max);
        b.approve(address(pair), type(uint256).max);
        pair.addLiquidity(1000 ether, 1000 ether, 1, DEADLINE);
        vm.stopPrank();

        a.mint(attacker, 100 ether);
        vm.startPrank(attacker);
        a.transfer(address(pair), 50 ether); // donate half
        a.approve(address(pair), type(uint256).max);
        uint256 out = pair.swap(aIsZero, 50 ether, 1, DEADLINE);
        vm.stopPrank();

        // The attacker spent 100 of token a in total and received `out` of token b.
        assertLt(out, 100 ether, "donation is not recoverable through the swap");
    }

    /// H4: a fee-on-transfer token as an INTERMEDIATE hop. The router forwards the
    /// pair's reported output to the next hop, but will be holding less than that.
    /// This must fail closed, never silently mis-settle.
    function testRouterWithSkimmingIntermediateHopFailsClosed() public {
        AuditToken tokenIn = new AuditToken();
        SkimToken mid = new SkimToken();
        AuditToken tokenOut = new AuditToken();

        ArcPairFactory factory = new ArcPairFactory(treasury);
        ArcRouter router = new ArcRouter(factory);

        address p1 = factory.createPair(address(tokenIn), address(mid), 30);
        address p2 = factory.createPair(address(mid), address(tokenOut), 30);

        tokenIn.mint(alice, 10_000 ether);
        mid.mint(alice, 10_000 ether);
        tokenOut.mint(alice, 10_000 ether);
        vm.startPrank(alice);
        tokenIn.approve(p1, type(uint256).max);
        mid.approve(p1, type(uint256).max);
        mid.approve(p2, type(uint256).max);
        tokenOut.approve(p2, type(uint256).max);
        ArcPair(p1).addLiquidity(1000 ether, 1000 ether, 1, DEADLINE);
        ArcPair(p2).addLiquidity(1000 ether, 1000 ether, 1, DEADLINE);
        vm.stopPrank();

        address[] memory path = new address[](3);
        path[0] = address(tokenIn);
        path[1] = address(mid);
        path[2] = address(tokenOut);

        tokenIn.mint(attacker, 100 ether);
        vm.startPrank(attacker);
        tokenIn.approve(address(router), type(uint256).max);
        uint256 before = tokenIn.balanceOf(attacker);
        // Either it reverts, or it settles honestly — it must never leave the
        // router holding value or hand out more than the pools gave.
        try router.swapExactTokensForTokens(path, 100 ether, 1, DEADLINE) returns (uint256 amountOut) {
            assertEq(tokenOut.balanceOf(attacker), amountOut, "settled exactly what was reported");
            assertEq(tokenIn.balanceOf(address(router)), 0, "router holds no input");
            assertEq(tokenOut.balanceOf(address(router)), 0, "router holds no output");
        } catch {
            assertEq(tokenIn.balanceOf(attacker), before, "input fully returned on revert");
            assertEq(tokenOut.balanceOf(address(router)), 0, "router holds nothing after revert");
        }
        vm.stopPrank();
    }

    /// H5: the router must never end a call holding a balance, even on the happy path.
    function testRouterNeverRetainsBalance() public {
        AuditToken x = new AuditToken();
        AuditToken y = new AuditToken();
        ArcPairFactory factory = new ArcPairFactory(treasury);
        ArcRouter router = new ArcRouter(factory);
        address p = factory.createPair(address(x), address(y), 30);

        x.mint(alice, 10_000 ether);
        y.mint(alice, 10_000 ether);
        vm.startPrank(alice);
        x.approve(p, type(uint256).max);
        y.approve(p, type(uint256).max);
        ArcPair(p).addLiquidity(1000 ether, 1000 ether, 1, DEADLINE);
        vm.stopPrank();

        address[] memory path = new address[](2);
        path[0] = address(x);
        path[1] = address(y);

        x.mint(attacker, 100 ether);
        vm.startPrank(attacker);
        x.approve(address(router), type(uint256).max);
        router.swapExactTokensForTokens(path, 100 ether, 1, DEADLINE);
        vm.stopPrank();

        assertEq(x.balanceOf(address(router)), 0);
        assertEq(y.balanceOf(address(router)), 0);
    }

    /// H6: sweeping protocol fees must not disturb reserves, even called repeatedly.
    function testRepeatedSweepIsHarmless() public {
        AuditToken a = new AuditToken();
        AuditToken b = new AuditToken();
        ArcPair pair = _pairOf(address(a), address(b));
        bool aIsZero = address(a) < address(b);

        a.mint(alice, 10_000 ether);
        b.mint(alice, 10_000 ether);
        vm.startPrank(alice);
        a.approve(address(pair), type(uint256).max);
        b.approve(address(pair), type(uint256).max);
        pair.addLiquidity(1000 ether, 1000 ether, 1, DEADLINE);
        a.approve(address(pair), type(uint256).max);
        pair.swap(aIsZero, 100 ether, 1, DEADLINE);
        vm.stopPrank();

        uint256 r0 = pair.reserve0();
        uint256 r1 = pair.reserve1();
        pair.sweepProtocolFees();
        pair.sweepProtocolFees();
        pair.sweepProtocolFees();

        assertEq(pair.reserve0(), r0, "reserves untouched by repeated sweeps");
        assertEq(pair.reserve1(), r1, "reserves untouched by repeated sweeps");
        assertEq(pair.protocol0(), 0);
        assertEq(pair.protocol1(), 0);
    }
}

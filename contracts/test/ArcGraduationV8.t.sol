// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {ArcPair} from "../src/ArcPair.sol";
import {ArcPairFactoryV2} from "../src/ArcPairFactoryV2.sol";
import {ArcPumpCurveV8, ArcPumpFactoryV8} from "../src/ArcPumpV8.sol";
import {PumpToken} from "../src/ArcPump.sol";

/// Stands in for the dual-interface USDC. Etched at the constant address the
/// curve compiles against, so the test exercises the real code path.
contract MockUsdc {
    uint8 public constant decimals = 6;
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

contract ArcGraduationV8Test is Test {
    address constant USDC = 0x3600000000000000000000000000000000000000;
    address payable treasury = payable(address(0xFEE));
    address creator = address(0xC0FFEE);
    address attacker = address(0xBAD);
    address buyer = address(0xB0B);

    ArcPairFactoryV2 pairFactory;
    ArcPumpFactoryV8 pumpFactory;
    uint256 threshold = 4_500 ether;

    function setUp() public {
        vm.etch(USDC, address(new MockUsdc()).code);

        pairFactory = new ArcPairFactoryV2(treasury);
        pumpFactory = new ArcPumpFactoryV8(pairFactory, treasury, threshold);
        pairFactory.setGraduationAuthority(address(pumpFactory));
    }

    function _launch() internal returns (PumpToken token, ArcPumpCurveV8 curve) {
        vm.prank(creator);
        (address t, address c) = pumpFactory.createLaunch("Test Coin", "TEST", "ipfs://x");
        return (PumpToken(t), ArcPumpCurveV8(c));
    }

    /// The whole reason V2 exists: the pair slot must not be occupiable while
    /// the curve is still running.
    function testAttackerCannotOpenThePairBeforeGraduation() public {
        (PumpToken token,) = _launch();

        vm.prank(attacker);
        vm.expectRevert("RESERVED_UNTIL_GRADUATION");
        pairFactory.createPair(address(token), USDC, 30);

        // Not just the graduation tier — every tier is reserved, or the
        // attacker simply moves down one.
        vm.prank(attacker);
        vm.expectRevert("RESERVED_UNTIL_GRADUATION");
        pairFactory.createPair(address(token), USDC, 10);
    }

    /// Reservation must be scoped to launch tokens, not a general freeze.
    function testUnrelatedTokensAreStillPermissionless() public {
        MockUsdc other = new MockUsdc();
        address pair = pairFactory.createPair(address(other), USDC, 30);
        assertTrue(pair != address(0));
    }

    function testOnlyACurveMayUseTheGraduationPath() public {
        (PumpToken token,) = _launch();
        vm.prank(attacker);
        vm.expectRevert("NOT_A_CURVE");
        pairFactory.createGraduationPair(address(token), USDC, 30);
    }

    /// The one-time setter is the only privilege in the factory. Prove it
    /// cannot be exercised twice or by anyone else.
    function testGraduationAuthorityIsSetOnceAndFrozen() public {
        ArcPairFactoryV2 fresh = new ArcPairFactoryV2(treasury);

        vm.prank(attacker);
        vm.expectRevert("NOT_DEPLOYER");
        fresh.setGraduationAuthority(attacker);

        fresh.setGraduationAuthority(address(pumpFactory));
        vm.expectRevert("ALREADY_SET");
        fresh.setGraduationAuthority(attacker);
    }

    /// Before an authority is set the factory is exactly the permissionless one.
    function testNothingIsReservedBeforeAnAuthorityExists() public {
        ArcPairFactoryV2 fresh = new ArcPairFactoryV2(treasury);
        (PumpToken token,) = _launch();
        assertFalse(fresh.isReserved(address(token)));
    }

    function _graduate() internal returns (PumpToken token, ArcPumpCurveV8 curve) {
        (token, curve) = _launch();

        // On Arc the curve's native balance *is* its USDC balance at 1e12
        // scale. The mock cannot mirror that automatically, so mint the
        // matching 6-decimal amount up front — graduation runs inside buy(),
        // so the balance has to be there before the threshold is crossed.
        uint256 spend = threshold * 10_100 / 10_000 + 1 ether; // clear 100 bps fee
        MockUsdc(USDC).mint(address(curve), spend / 1e12);

        vm.deal(buyer, spend);
        vm.prank(buyer);
        curve.buy{value: spend}(1, uint64(block.timestamp + 3600));
    }

    function testGraduationSeedsThePairAndBurnsTheLp() public {
        (PumpToken token, ArcPumpCurveV8 curve) = _graduate();

        assertTrue(curve.graduated(), "curve graduated");
        ArcPair pair = curve.pair();
        assertTrue(address(pair) != address(0), "pair created");

        assertGt(pair.totalSupply(), 0, "pair seeded");
        assertEq(pair.balanceOf(address(curve)), 0, "curve keeps no LP");
        assertGt(pair.balanceOf(curve.BURN()), 0, "LP burned to the dead address");

        assertGt(pair.reserve0(), 0);
        assertGt(pair.reserve1(), 0);
        assertEq(token.balanceOf(address(curve)), 0, "inventory moved into the pool");
        assertEq(curve.realNativeReserve(), 0, "quote reserve moved into the pool");
    }

    /// Once graduated the token is no longer reserved — a second tier becomes
    /// open to anyone, which is the point of graduating.
    function testTokenIsReleasedAfterGraduation() public {
        (PumpToken token,) = _graduate();
        assertFalse(pairFactory.isReserved(address(token)));

        vm.prank(attacker);
        address pair = pairFactory.createPair(address(token), USDC, 10);
        assertTrue(pair != address(0));
    }

    /// The curve is closed after graduation; late buyers must be rejected
    /// rather than trading against an empty inventory.
    function testCurveRejectsTradesAfterGraduation() public {
        (, ArcPumpCurveV8 curve) = _graduate();
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        vm.expectRevert("CURVE_CLOSED");
        curve.buy{value: 1 ether}(1, uint64(block.timestamp + 3600));
    }
}

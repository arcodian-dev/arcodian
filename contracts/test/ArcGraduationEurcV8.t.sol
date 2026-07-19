// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {ArcPair} from "../src/ArcPair.sol";
import {ArcPairFactoryV2} from "../src/ArcPairFactoryV2.sol";
import {ArcGraduationHub} from "../src/ArcGraduationHub.sol";
import {ArcPumpCurveEurcV8, ArcPumpFactoryEurcV8} from "../src/ArcPumpEurcV8.sol";
import {ArcPumpCurveV8, ArcPumpFactoryV8} from "../src/ArcPumpV8.sol";
import {PumpToken} from "../src/ArcPump.sol";
import {IERC20} from "../src/ArcFxPool.sol";

/// A plain 6-decimal ERC-20. Unlike the USDC path there is nothing to etch and
/// no precompile to stand in for — EURC really is just a token, which is why
/// graduation can be driven to completion here.
contract MockEurc {
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

/// A member that reverts on every question, to prove one broken factory cannot
/// take the whole exchange down with it.
contract BrokenMember {
    function isUngraduatedLaunchToken(address) external pure returns (bool) { revert("BROKEN"); }
    function isCurve(address) external pure returns (bool) { revert("BROKEN"); }
}

contract ArcGraduationEurcV8Test is Test {
    address payable treasury = payable(address(0xFEE));
    address creator = address(0xC0FFEE);
    address attacker = address(0xBAD);
    address buyer = address(0xB0B);

    MockEurc eurc;
    ArcPairFactoryV2 pairFactory;
    ArcGraduationHub hub;
    ArcPumpFactoryEurcV8 pumpFactory;
    uint256 threshold = 4_500_000_000; // 4,500 EURC

    function setUp() public {
        eurc = new MockEurc();
        hub = new ArcGraduationHub();
        pairFactory = new ArcPairFactoryV2(treasury);
        pairFactory.setGraduationAuthority(address(hub));

        pumpFactory = new ArcPumpFactoryEurcV8(pairFactory, IERC20(address(eurc)), treasury, threshold);
        hub.register(address(pumpFactory));
        hub.seal();
    }

    function _launch() internal returns (PumpToken token, ArcPumpCurveEurcV8 curve) {
        vm.prank(creator);
        (address t, address c) = pumpFactory.createLaunch("Euro Coin", "EUROC", "ipfs://x");
        return (PumpToken(t), ArcPumpCurveEurcV8(c));
    }

    function _graduate() internal returns (PumpToken token, ArcPumpCurveEurcV8 curve) {
        (token, curve) = _launch();
        uint256 spend = threshold * 10_100 / 10_000 + 1_000_000; // clear the 100 bps fee
        eurc.mint(buyer, spend);
        vm.startPrank(buyer);
        eurc.approve(address(curve), type(uint256).max);
        curve.buy(spend, 1, uint64(block.timestamp + 3600));
        vm.stopPrank();
    }

    // ---- the hub -----------------------------------------------------------

    function testHubAnswersForItsMembers() public {
        (PumpToken token, ArcPumpCurveEurcV8 curve) = _launch();
        assertTrue(hub.isUngraduatedLaunchToken(address(token)), "token reserved through the hub");
        assertTrue(hub.isCurve(address(curve)), "curve recognised through the hub");
        assertFalse(hub.isCurve(attacker));
    }

    /// The reason the hub exists at all: two launchpads, one pair registry.
    function testTwoPumpFactoriesShareOnePairRegistry() public {
        ArcGraduationHub fresh = new ArcGraduationHub();
        ArcPairFactoryV2 registry = new ArcPairFactoryV2(treasury);
        registry.setGraduationAuthority(address(fresh));

        ArcPumpFactoryEurcV8 eurcFactory =
            new ArcPumpFactoryEurcV8(registry, IERC20(address(eurc)), treasury, threshold);
        ArcPumpFactoryV8 usdcFactory = new ArcPumpFactoryV8(registry, treasury, 4_500 ether);
        fresh.register(address(eurcFactory));
        fresh.register(address(usdcFactory));
        fresh.seal();

        vm.prank(creator);
        (address eurcToken,) = eurcFactory.createLaunch("Euro Coin", "EUROC", "ipfs://x");
        vm.prank(creator);
        (address usdcToken,) = usdcFactory.createLaunch("Dollar Coin", "USDCC", "ipfs://x");

        // Both launchpads' tokens are protected by the same registry.
        assertTrue(registry.isReserved(eurcToken), "eurc token reserved");
        assertTrue(registry.isReserved(usdcToken), "usdc token reserved");
    }

    function testSealedHubRejectsFurtherMembers() public {
        vm.expectRevert("SEALED");
        hub.register(attacker);
    }

    function testOnlyDeployerMayRegisterOrSeal() public {
        ArcGraduationHub fresh = new ArcGraduationHub();
        vm.prank(attacker);
        vm.expectRevert("NOT_DEPLOYER");
        fresh.register(attacker);

        vm.prank(attacker);
        vm.expectRevert("NOT_DEPLOYER");
        fresh.seal();
    }

    /// An empty sealed hub would permanently disable graduation for its registry.
    function testHubCannotBeSealedEmpty() public {
        ArcGraduationHub fresh = new ArcGraduationHub();
        vm.expectRevert("NO_MEMBERS");
        fresh.seal();
    }

    /// One member reverting must not freeze pair creation for every token.
    function testBrokenMemberDoesNotFreezeTheExchange() public {
        ArcGraduationHub fresh = new ArcGraduationHub();
        ArcPairFactoryV2 registry = new ArcPairFactoryV2(treasury);
        registry.setGraduationAuthority(address(fresh));

        fresh.register(address(new BrokenMember()));
        ArcPumpFactoryEurcV8 working =
            new ArcPumpFactoryEurcV8(registry, IERC20(address(eurc)), treasury, threshold);
        fresh.register(address(working));
        fresh.seal();

        vm.prank(creator);
        (address token,) = working.createLaunch("Euro Coin", "EUROC", "ipfs://x");

        // The broken member is skipped, and the working one is still heard.
        assertTrue(registry.isReserved(token), "working member still answers");

        MockEurc unrelated = new MockEurc();
        assertTrue(registry.createPair(address(unrelated), address(eurc), 30) != address(0));
    }

    // ---- reservation -------------------------------------------------------

    function testAttackerCannotOpenThePairBeforeGraduation() public {
        (PumpToken token,) = _launch();

        vm.prank(attacker);
        vm.expectRevert("RESERVED_UNTIL_GRADUATION");
        pairFactory.createPair(address(token), address(eurc), 30);

        // Every tier, or the attacker just moves down one.
        vm.prank(attacker);
        vm.expectRevert("RESERVED_UNTIL_GRADUATION");
        pairFactory.createPair(address(token), address(eurc), 10);
    }

    function testOnlyACurveMayUseTheGraduationPath() public {
        (PumpToken token,) = _launch();
        vm.prank(attacker);
        vm.expectRevert("NOT_A_CURVE");
        pairFactory.createGraduationPair(address(token), address(eurc), 30);
    }

    // ---- graduation, end to end -------------------------------------------

    function testGraduationSeedsThePairAndBurnsTheLp() public {
        (PumpToken token, ArcPumpCurveEurcV8 curve) = _graduate();

        assertTrue(curve.graduated(), "curve graduated");
        ArcPair pair = curve.pair();
        assertTrue(address(pair) != address(0), "pair created");

        assertGt(pair.totalSupply(), 0, "pair seeded");
        assertEq(pair.balanceOf(address(curve)), 0, "curve keeps no LP");
        assertGt(pair.balanceOf(curve.BURN()), 0, "LP burned to the dead address");

        assertGt(pair.reserve0(), 0);
        assertGt(pair.reserve1(), 0);
        assertEq(token.balanceOf(address(curve)), 0, "inventory moved into the pool");
        assertEq(curve.realQuoteReserve(), 0, "quote reserve moved into the pool");
    }

    /// The pool must actually hold the collateral, not merely report reserves —
    /// this is the assertion the USDC suite cannot make against a precompile.
    function testGraduatedPoolHoldsTheRealCollateral() public {
        (PumpToken token, ArcPumpCurveEurcV8 curve) = _graduate();
        ArcPair pair = curve.pair();

        uint256 pooledEurc = eurc.balanceOf(address(pair));
        assertGt(pooledEurc, 0, "pool holds EURC");
        assertEq(eurc.balanceOf(address(curve)), curve.accruedProtocolFees(), "curve keeps only fees");
        assertEq(token.balanceOf(address(pair)), pair.reserve0() + pair.reserve1() - pooledEurc, "token pooled");
    }

    /// A trade against the graduated pool must succeed — a seeded pool that
    /// cannot be traded is not a working market.
    function testGraduatedPoolIsTradable() public {
        (PumpToken token, ArcPumpCurveEurcV8 curve) = _graduate();
        ArcPair pair = curve.pair();

        eurc.mint(buyer, 100_000_000);
        uint256 before = token.balanceOf(buyer);

        vm.startPrank(buyer);
        eurc.approve(address(pair), type(uint256).max);
        bool eurcIsToken0 = address(eurc) < address(token);
        pair.swap(eurcIsToken0, 10_000_000, 1, uint64(block.timestamp + 3600));
        vm.stopPrank();

        assertGt(token.balanceOf(buyer), before, "buyer received tokens from the pool");
    }

    function testTokenIsReleasedAfterGraduation() public {
        (PumpToken token,) = _graduate();
        assertFalse(pairFactory.isReserved(address(token)));

        vm.prank(attacker);
        assertTrue(pairFactory.createPair(address(token), address(eurc), 10) != address(0));
    }

    function testCurveRejectsTradesAfterGraduation() public {
        (, ArcPumpCurveEurcV8 curve) = _graduate();
        eurc.mint(buyer, 1_000_000);
        vm.startPrank(buyer);
        eurc.approve(address(curve), type(uint256).max);
        vm.expectRevert("CURVE_CLOSED");
        curve.buy(1_000_000, 1, uint64(block.timestamp + 3600));
        vm.stopPrank();
    }
}

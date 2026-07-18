// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {ArcDexFactory, ArcDexPair, ArcPumpCurve, ArcPumpFactory, ArcPumpSuite, PumpToken} from "../src/ArcPump.sol";

contract ArcPumpTest is Test {
    ArcDexFactory dex;
    ArcPumpFactory factory;
    ArcPumpCurve curve;
    PumpToken token;
    address creator = address(0xC0FFEE);
    address buyer = address(0xB0B);
    address payable treasury = payable(address(0xFEE));

    function setUp() public {
        dex = new ArcDexFactory(treasury); factory = new ArcPumpFactory(dex, treasury, 4_500 ether); dex.setPumpFactory(address(factory));
        vm.prank(creator); (address token_, address curve_) = factory.createLaunch("Arc Cat", "ACAT", "ipfs://bafy-test");
        token = PumpToken(token_); curve = ArcPumpCurve(payable(curve_)); vm.deal(buyer, 100 ether);
    }

    function testSupplyAlwaysOneBillion() public view { assertEq(token.totalSupply(), 1_000_000_000 ether); assertEq(token.balanceOf(address(curve)), token.totalSupply()); assertEq(token.imageURI(), "ipfs://bafy-test"); }

    function testBuyThenSellBeforeGraduation() public {
        uint256 treasuryBefore = treasury.balance;
        vm.prank(buyer); uint256 bought = curve.buy{value: 1 ether}(1, uint64(block.timestamp + 1));
        assertEq(treasury.balance - treasuryBefore, 0.01 ether);
        vm.prank(buyer); token.approve(address(curve), bought);
        uint256 before = buyer.balance; vm.prank(buyer); uint256 received = curve.sell(bought, 1, uint64(block.timestamp + 1));
        assertEq(buyer.balance, before + received); assertLe(received, 1 ether); assertFalse(curve.graduated());
    }

    function testGraduationCreatesDexAndBurnsAllLp() public {
        vm.deal(buyer, 6_000 ether);
        vm.prank(buyer); curve.buy{value: 4_600 ether}(1, uint64(block.timestamp + 1));
        assertTrue(curve.graduated()); ArcDexPair pair = curve.pair();
        assertEq(dex.pairFor(address(token)), address(pair)); assertGt(pair.totalSupply(), 0);
        assertEq(pair.balanceOf(pair.BURN()), pair.totalSupply()); assertEq(token.balanceOf(address(curve)), 0); assertEq(address(curve).balance, 0);
    }

    function testDexBuyAndSellAfterGraduation() public {
        vm.deal(buyer, 6_000 ether);
        vm.prank(buyer); curve.buy{value: 4_600 ether}(1, uint64(block.timestamp + 1)); ArcDexPair pair = curve.pair();
        vm.prank(buyer); uint256 out = pair.buy{value: 1 ether}(1, uint64(block.timestamp + 1));
        vm.prank(buyer); token.approve(address(pair), out); vm.prank(buyer); uint256 nativeOut = pair.sell(out, 1, uint64(block.timestamp + 1)); assertGt(nativeOut, 0);
    }

    function testSuiteDeploysBothFactories() public {
        ArcPumpSuite suite = new ArcPumpSuite(4_500 ether, treasury);
        assertTrue(address(suite.dexFactory()) != address(0));
        assertTrue(address(suite.pumpFactory()) != address(0));
        assertEq(suite.graduationThreshold(), 4_500 ether);
        assertEq(suite.pumpFactory().graduationThreshold(), 4_500 ether);
        assertEq(address(suite.pumpFactory().dexFactory()), address(suite.dexFactory()));
        assertEq(suite.treasury(), treasury);
    }

    function testCurveClosesAfterGraduation() public {
        vm.deal(buyer, 6_000 ether);
        vm.prank(buyer); curve.buy{value: 4_600 ether}(1, uint64(block.timestamp + 1));
        vm.expectRevert("CURVE_CLOSED");
        vm.prank(buyer); curve.buy{value: 1 ether}(1, uint64(block.timestamp + 1));
    }

    function testAttackerCannotPrecreatePair() public {
        vm.expectRevert("NOT_AUTHORIZED");
        vm.prank(buyer); dex.createPair(token, buyer);
    }

    function testV5EconomicsAndLiquidityAllocation() public {
        assertEq(curve.VIRTUAL_NATIVE(), 1_000 ether);
        vm.deal(buyer, 6_000 ether);
        vm.prank(buyer); curve.buy{value: 4_600 ether}(1, uint64(block.timestamp + 1));
        ArcDexPair pair = curve.pair();
        assertTrue(curve.graduated());
        assertGe(pair.nativeReserve(), 4_500 ether);
        assertGt(pair.tokenReserve(), 180_000_000 ether);
        assertLt(pair.tokenReserve(), 185_000_000 ether);
        assertEq(pair.balanceOf(pair.BURN()), pair.totalSupply());
        assertEq(token.balanceOf(address(pair)) + token.balanceOf(buyer), token.totalSupply());
    }

    function testGraduationV5EndToEndSmoke() public {
        uint256 treasuryBefore = treasury.balance;
        vm.deal(buyer, 6_000 ether);
        vm.prank(buyer);
        uint256 buyerTokens = curve.buy{value: 4_600 ether}(1, uint64(block.timestamp + 1));

        ArcDexPair pair = curve.pair();
        assertTrue(curve.graduated());
        assertEq(treasury.balance - treasuryBefore, 46 ether);
        assertEq(pair.nativeReserve(), 4_554 ether);
        assertEq(address(pair).balance, pair.nativeReserve());
        assertEq(token.balanceOf(address(pair)), pair.tokenReserve());
        assertEq(token.balanceOf(buyer), buyerTokens);
        assertEq(pair.balanceOf(pair.BURN()), pair.totalSupply());
        assertEq(pair.balanceOf(buyer), 0);
        assertEq(dex.pairFor(address(token)), address(pair));

        vm.expectRevert("CURVE_CLOSED");
        vm.prank(buyer);
        curve.buy{value: 1 ether}(1, uint64(block.timestamp + 1));

        vm.expectRevert("CURVE_CLOSED");
        vm.prank(buyer);
        curve.sell(1, 1, uint64(block.timestamp + 1));

        uint256 dexTreasuryBefore = treasury.balance;
        vm.prank(buyer);
        uint256 dexTokens = pair.buy{value: 1 ether}(1, uint64(block.timestamp + 1));
        assertGt(dexTokens, 0);
        assertEq(treasury.balance - dexTreasuryBefore, 0.0005 ether);
        vm.prank(buyer);
        token.approve(address(pair), dexTokens);
        vm.prank(buyer);
        uint256 nativeBack = pair.sell(dexTokens, 1, uint64(block.timestamp + 1));
        assertGt(nativeBack, 0);
        assertEq(pair.balanceOf(pair.BURN()), pair.totalSupply());
    }

    function testFuzzCurveAccounting(uint96 raw) public {
        uint256 amount = bound(uint256(raw), 1e12, 9 ether); vm.prank(buyer); uint256 out = curve.buy{value: amount}(1, uint64(block.timestamp + 1));
        assertGt(out, 0); assertEq(address(curve).balance, curve.realNativeReserve()); assertEq(token.balanceOf(buyer) + token.balanceOf(address(curve)), token.totalSupply());
    }
}

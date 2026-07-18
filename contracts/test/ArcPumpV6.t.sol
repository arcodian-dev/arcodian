// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {PumpToken} from "../src/ArcPump.sol";
import {ArcPumpSuiteV6, ArcPumpFactoryV6, ArcDexFactoryV6, ArcPumpCurveV6, ArcDexPairV6} from "../src/ArcPumpV6.sol";

contract RejectingTreasury {
    receive() external payable {
        revert("NO_NATIVE");
    }

    function withdraw(address vault) external {
        ArcPumpCurveV6(payable(vault)).withdrawProtocolFees();
    }
}

contract ArcPumpV6Test is Test {
    address buyer = address(0xB0B);
    address payable treasury = payable(address(0xFEE));

    function _launch(address payable feeRecipient)
        internal
        returns (ArcPumpCurveV6 curve, PumpToken token, ArcDexFactoryV6 dex)
    {
        ArcPumpSuiteV6 suite = new ArcPumpSuiteV6(4_500 ether, feeRecipient);
        ArcPumpFactoryV6 factory = suite.pumpFactory();
        dex = suite.dexFactory();
        (address tokenAddress, address curveAddress) =
            factory.createLaunch("V6 Test", "V6T", "https://example.com/v6.webp");
        token = PumpToken(tokenAddress);
        curve = ArcPumpCurveV6(payable(curveAddress));
    }

    function testEngineVersionIsExplicit() public {
        ArcPumpSuiteV6 suite = new ArcPumpSuiteV6(4_500 ether, treasury);
        assertEq(suite.ENGINE_VERSION(), 6);
        assertEq(suite.pumpFactory().ENGINE_VERSION(), 6);
        assertEq(suite.dexFactory().ENGINE_VERSION(), 6);
    }

    function testRejectingTreasuryCannotBlockTrading() public {
        RejectingTreasury rejecting = new RejectingTreasury();
        (ArcPumpCurveV6 curve, PumpToken token,) = _launch(payable(address(rejecting)));
        vm.deal(buyer, 10 ether);
        vm.prank(buyer);
        uint256 out = curve.buy{value: 1 ether}(1, uint64(block.timestamp + 1));
        assertGt(out, 0);
        assertEq(token.balanceOf(buyer), out);
        assertEq(curve.accruedProtocolFees(), 0.01 ether);
        vm.expectRevert("WITHDRAW_FAILED");
        rejecting.withdraw(address(curve));
        assertEq(curve.accruedProtocolFees(), 0.01 ether);

        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        uint256 secondOut = curve.buy{value: 1 ether}(1, uint64(block.timestamp + 1));
        assertGt(secondOut, 0);
        assertEq(curve.accruedProtocolFees(), 0.02 ether);
    }

    function testTreasuryPullWithdrawal() public {
        (ArcPumpCurveV6 curve,,) = _launch(treasury);
        vm.deal(buyer, 2 ether);
        vm.prank(buyer);
        curve.buy{value: 2 ether}(1, uint64(block.timestamp + 1));
        uint256 beforeBalance = treasury.balance;
        vm.prank(treasury);
        curve.withdrawProtocolFees();
        assertEq(treasury.balance - beforeBalance, 0.02 ether);
        assertEq(curve.accruedProtocolFees(), 0);
    }

    function testFuzzCurveFeesNeverEnterReserve(uint96 rawAmount) public {
        uint256 amount = bound(uint256(rawAmount), 0.001 ether, 100 ether);
        (ArcPumpCurveV6 curve,,) = _launch(treasury);
        vm.deal(buyer, amount);
        vm.prank(buyer);
        curve.buy{value: amount}(1, uint64(block.timestamp + 1));
        uint256 fee = amount / 100;
        assertEq(curve.accruedProtocolFees(), fee);
        assertEq(curve.realNativeReserve(), amount - fee);
        assertEq(address(curve).balance, curve.realNativeReserve() + curve.accruedProtocolFees());
    }

    function testOnlyTreasuryCanWithdraw() public {
        (ArcPumpCurveV6 curve,,) = _launch(treasury);
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        curve.buy{value: 1 ether}(1, uint64(block.timestamp + 1));
        vm.prank(buyer);
        vm.expectRevert("TREASURY_ONLY");
        curve.withdrawProtocolFees();
    }

    function testRejectingTreasuryCannotBlockDexTrading() public {
        RejectingTreasury rejecting = new RejectingTreasury();
        (ArcPumpCurveV6 curve,,) = _launch(payable(address(rejecting)));
        vm.deal(buyer, 5_000 ether);
        vm.prank(buyer);
        curve.buy{value: 4_600 ether}(1, uint64(block.timestamp + 1));
        assertTrue(curve.graduated());
        ArcDexPairV6 pair = curve.pair();
        assertEq(curve.accruedProtocolFees(), 46 ether);
        assertEq(address(curve).balance, 46 ether);
        assertEq(pair.nativeReserve(), 4_554 ether);
        uint256 reserveBefore = pair.nativeReserve();
        vm.prank(buyer);
        uint256 out = pair.buy{value: 1 ether}(1, uint64(block.timestamp + 1));
        assertGt(out, 0);
        assertEq(pair.accruedProtocolFees(), 0.0005 ether);
        assertEq(pair.nativeReserve(), reserveBefore + 1 ether - 0.0005 ether);
    }
}

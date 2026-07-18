// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {PumpToken} from "../src/ArcPump.sol";
import {ArcPumpSuiteV7, ArcPumpFactoryV7, ArcDexFactoryV7, ArcPumpCurveV7, ArcDexPairV7} from "../src/ArcPumpV7.sol";

contract RejectingTreasury {
    receive() external payable {
        revert("NO_NATIVE");
    }

    function withdraw(address vault) external {
        ArcPumpCurveV7(payable(vault)).withdrawProtocolFees();
    }
}

contract ArcPumpV7Test is Test {
    address buyer = address(0xB0B);
    address payable treasury = payable(address(0xFEE));

    function _launch(address payable feeRecipient)
        internal
        returns (ArcPumpCurveV7 curve, PumpToken token, ArcDexFactoryV7 dex)
    {
        ArcPumpSuiteV7 suite = new ArcPumpSuiteV7(4_500 ether, feeRecipient);
        ArcPumpFactoryV7 factory = suite.pumpFactory();
        dex = suite.dexFactory();
        (address tokenAddress, address curveAddress) =
            factory.createLaunch("V7 Test", "V7T", "https://example.com/v6.webp");
        token = PumpToken(tokenAddress);
        curve = ArcPumpCurveV7(payable(curveAddress));
    }

    function testEngineVersionIsExplicit() public {
        ArcPumpSuiteV7 suite = new ArcPumpSuiteV7(4_500 ether, treasury);
        assertEq(suite.ENGINE_VERSION(), 7);
        assertEq(suite.pumpFactory().ENGINE_VERSION(), 7);
        assertEq(suite.dexFactory().ENGINE_VERSION(), 7);
    }

    function testRejectingTreasuryCannotBlockTrading() public {
        RejectingTreasury rejecting = new RejectingTreasury();
        (ArcPumpCurveV7 curve, PumpToken token,) = _launch(payable(address(rejecting)));
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
        (ArcPumpCurveV7 curve,,) = _launch(treasury);
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
        (ArcPumpCurveV7 curve,,) = _launch(treasury);
        vm.deal(buyer, amount);
        vm.prank(buyer);
        curve.buy{value: amount}(1, uint64(block.timestamp + 1));
        uint256 fee = amount / 100;
        assertEq(curve.accruedProtocolFees(), fee);
        assertEq(curve.realNativeReserve(), amount - fee);
        assertEq(address(curve).balance, curve.realNativeReserve() + curve.accruedProtocolFees());
    }

    function testOnlyTreasuryCanWithdraw() public {
        (ArcPumpCurveV7 curve,,) = _launch(treasury);
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        curve.buy{value: 1 ether}(1, uint64(block.timestamp + 1));
        vm.prank(buyer);
        vm.expectRevert("TREASURY_ONLY");
        curve.withdrawProtocolFees();
    }

    function testRejectingTreasuryCannotBlockDexTrading() public {
        RejectingTreasury rejecting = new RejectingTreasury();
        (ArcPumpCurveV7 curve,,) = _launch(payable(address(rejecting)));
        vm.deal(buyer, 5_000 ether);
        vm.prank(buyer);
        curve.buy{value: 4_600 ether}(1, uint64(block.timestamp + 1));
        assertTrue(curve.graduated());
        ArcDexPairV7 pair = curve.pair();
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

    /// @notice V7 fix: DEX sell applies the same 30 bps haircut as buy (V6 used 25).
    function testDexSellUsesSymmetricThirtyBps() public {
        (ArcPumpCurveV7 curve, PumpToken token,) = _launch(treasury);
        vm.deal(buyer, 5_000 ether);
        vm.prank(buyer);
        curve.buy{value: 4_600 ether}(1, uint64(block.timestamp + 1));
        assertTrue(curve.graduated());
        ArcDexPairV7 pair = curve.pair();

        uint256 tokenIn = token.balanceOf(buyer) / 10;
        vm.prank(buyer);
        token.approve(address(pair), tokenIn);

        uint256 tr = pair.tokenReserve();
        uint256 nr = pair.nativeReserve();
        uint256 inWithFee = tokenIn * (10_000 - 30);
        uint256 grossOut = nr * inWithFee / (tr * 10_000 + inWithFee);
        uint256 fee = grossOut * 5 / 10_000;
        uint256 expected = grossOut - fee;

        uint256 feesBefore = pair.accruedProtocolFees();
        vm.prank(buyer);
        uint256 out = pair.sell(tokenIn, 1, uint64(block.timestamp + 1));
        assertEq(out, expected);
        assertEq(pair.accruedProtocolFees() - feesBefore, fee);
    }
}

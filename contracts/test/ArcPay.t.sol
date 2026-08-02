// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {ArcPay} from "../src/ArcPay.sol";

contract RejectNative {
    receive() external payable {
        revert("NO_NATIVE");
    }
}

contract ArcPayTest is Test {
    ArcPay arcPay;
    address payable treasury = payable(address(0xFEE));
    address payable merchant = payable(address(0xBEEF));
    address payer = address(0xA11CE);
    bytes32 invoice = keccak256("invoice-001");
    uint256 amount = 100 ether;
    uint64 expiry;

    function setUp() public {
        arcPay = new ArcPay(treasury);
        expiry = uint64(block.timestamp + 1 hours);
        vm.deal(payer, 1_000 ether);
        vm.deal(merchant, 1_000 ether);
    }

    function _pay() internal {
        vm.prank(payer);
        arcPay.pay{value: amount}(invoice, merchant, amount, expiry, payer, keccak256("order-1"));
    }

    function testPaymentSplitsThirtyBpsAndStoresReceipt() public {
        uint256 merchantBefore = merchant.balance;
        _pay();
        uint256 fee = arcPay.quoteFee(amount);
        assertEq(fee, 0.3 ether);
        assertEq(merchant.balance, merchantBefore + amount - fee);
        assertEq(treasury.balance, 0);
        assertEq(arcPay.accruedFees(), fee);
        (address storedPayer, address storedMerchant, uint128 gross, uint128 storedFee,, bool refunded) =
            arcPay.payments(invoice);
        assertEq(storedPayer, payer);
        assertEq(storedMerchant, merchant);
        assertEq(gross, amount);
        assertEq(storedFee, fee);
        assertFalse(refunded);
        assertEq(address(arcPay).balance, fee);
    }

    function testOnlyTreasuryCanWithdrawAccruedFees() public {
        _pay();
        uint256 fee = arcPay.accruedFees();
        vm.prank(payer);
        vm.expectRevert(ArcPay.TreasuryOnly.selector);
        arcPay.withdrawProtocolFees();
        vm.prank(treasury);
        arcPay.withdrawProtocolFees();
        assertEq(treasury.balance, fee);
        assertEq(arcPay.accruedFees(), 0);
        assertEq(address(arcPay).balance, 0);
    }

    function testRejectsReplay() public {
        _pay();
        vm.deal(payer, amount);
        vm.prank(payer);
        vm.expectRevert(ArcPay.InvoiceAlreadyPaid.selector);
        arcPay.pay{value: amount}(invoice, merchant, amount, expiry, payer, bytes32(0));
    }

    function testRejectsWrongPayer() public {
        address attacker = address(0xBAD);
        vm.deal(attacker, amount);
        vm.prank(attacker);
        vm.expectRevert(ArcPay.WrongPayer.selector);
        arcPay.pay{value: amount}(invoice, merchant, amount, expiry, payer, bytes32(0));
    }

    function testRejectsExpiredAndExcessivelyLongInvoice() public {
        vm.warp(1000);
        vm.startPrank(payer);
        vm.expectRevert(ArcPay.InvalidExpiry.selector);
        arcPay.pay{value: amount}(invoice, merchant, amount, 999, payer, bytes32(0));
        vm.expectRevert(ArcPay.InvalidExpiry.selector);
        arcPay.pay{value: amount}(invoice, merchant, amount, uint64(block.timestamp + 31 days), payer, bytes32(0));
        vm.stopPrank();
    }

    function testRejectsUnderpaymentAndOverpayment() public {
        vm.startPrank(payer);
        vm.expectRevert(ArcPay.InvalidAmount.selector);
        arcPay.pay{value: amount - 1}(invoice, merchant, amount, expiry, payer, bytes32(0));
        vm.expectRevert(ArcPay.InvalidAmount.selector);
        arcPay.pay{value: amount + 1}(invoice, merchant, amount, expiry, payer, bytes32(0));
        vm.stopPrank();
    }

    function testMerchantCanRefundFullGrossAmountOnce() public {
        _pay();
        uint256 payerBefore = payer.balance;
        vm.prank(merchant);
        arcPay.refund{value: amount}(invoice);
        assertEq(payer.balance, payerBefore + amount);
        (,,,,, bool refunded) = arcPay.payments(invoice);
        assertTrue(refunded);
        vm.prank(merchant);
        vm.expectRevert(ArcPay.AlreadyRefunded.selector);
        arcPay.refund{value: amount}(invoice);
    }

    function testNonMerchantCannotRefund() public {
        _pay();
        vm.deal(payer, amount);
        vm.prank(payer);
        vm.expectRevert(ArcPay.MerchantOnly.selector);
        arcPay.refund{value: amount}(invoice);
    }

    function testRejectingMerchantRevertsAccountingAndFee() public {
        RejectNative rejector = new RejectNative();
        vm.prank(payer);
        vm.expectRevert(ArcPay.TransferFailed.selector);
        arcPay.pay{value: amount}(invoice, payable(address(rejector)), amount, expiry, payer, bytes32(0));
        (address storedPayer,,,,,) = arcPay.payments(invoice);
        assertEq(storedPayer, address(0));
        assertEq(arcPay.accruedFees(), 0);
    }

    function testFuzzFeeNeverExceedsAmount(uint128 raw) public view {
        uint256 value = bound(uint256(raw), 1, type(uint128).max);
        uint256 fee = arcPay.quoteFee(value);
        assertGt(fee, 0);
        assertLe(fee, value);
    }
}

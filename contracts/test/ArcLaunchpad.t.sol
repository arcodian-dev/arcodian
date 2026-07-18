// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {ArcLaunchpadFactory, ArcLaunchSale, ArcToken} from "../src/ArcLaunchpad.sol";

contract ArcLaunchpadTest is Test {
    ArcLaunchpadFactory factory;
    ArcLaunchSale sale;
    ArcToken token;
    address creator = address(0xC0FFEE);
    address buyer = address(0xB0B);

    function setUp() public {
        factory = new ArcLaunchpadFactory();
        vm.prank(creator);
        (address token_, address sale_) = factory.createLaunch(
            "Arc One",
            "ARC1",
            1_000_000 ether,
            800_000 ether,
            uint64(block.timestamp),
            uint64(block.timestamp + 7 days),
            1_000 ether,
            100 ether,
            20 ether
        );
        token = ArcToken(token_);
        sale = ArcLaunchSale(payable(sale_));
        vm.deal(buyer, 200 ether);
    }

    function testAllocationIsExact() public view {
        assertEq(token.balanceOf(address(sale)), 800_000 ether);
        assertEq(token.balanceOf(creator), 200_000 ether);
        assertEq(token.totalSupply(), 1_000_000 ether);
    }

    function testBuyHonorsMinimumOutput() public {
        vm.prank(buyer);
        sale.buy{value: 10 ether}(10_000 ether, uint64(block.timestamp + 1));
        assertEq(token.balanceOf(buyer), 0);
        assertEq(sale.purchasedTokens(buyer), 10_000 ether);
        assertEq(sale.raised(), 10 ether);
    }

    function testFuzzPurchaseAccounting(uint96 raw) public {
        uint256 amount = bound(uint256(raw), 1e15, 100 ether);
        vm.prank(buyer);
        sale.buy{value: amount}(amount * 1_000, uint64(block.timestamp + 1));
        assertEq(sale.raised(), amount);
        assertEq(sale.contributed(buyer), amount);
        assertEq(sale.purchasedTokens(buyer), amount * 1_000);
    }

    function testRefundWhenMinimumMissed() public {
        vm.prank(buyer);
        sale.buy{value: 10 ether}(0, uint64(block.timestamp + 1));
        vm.warp(block.timestamp + 8 days);
        uint256 before = buyer.balance;
        vm.prank(buyer);
        sale.refund();
        assertEq(buyer.balance, before + 10 ether);
        assertEq(sale.contributed(buyer), 0);
        assertEq(sale.purchasedTokens(buyer), 0);
    }

    function testFinalizePaysCreatorAfterMinimum() public {
        vm.prank(buyer);
        sale.buy{value: 20 ether}(0, uint64(block.timestamp + 1));
        vm.warp(block.timestamp + 8 days);
        uint256 before = creator.balance;
        sale.finalize();
        assertTrue(sale.settled());
        vm.prank(creator);
        sale.claimProceeds();
        assertEq(creator.balance, before + 20 ether);
        vm.prank(buyer);
        sale.claimTokens();
        assertEq(token.balanceOf(buyer), 20_000 ether);
    }

    function testCannotFinalizeBelowMinimum() public {
        vm.prank(buyer);
        sale.buy{value: 1 ether}(0, uint64(block.timestamp + 1));
        vm.warp(block.timestamp + 8 days);
        vm.expectRevert("MIN_NOT_MET");
        sale.finalize();
    }
}

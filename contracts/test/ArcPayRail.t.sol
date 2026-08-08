// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ArcPayRail.sol";
import "../src/ArcServiceRegistry.sol";
import "./mocks/MockPassport.sol";

contract ArcPayRailTest is Test {
    ArcPayRail rail;
    ArcServiceRegistry reg;
    MockPassport passport;
    address provider = makeAddr("provider");
    address payer = makeAddr("payer");
    address treasury = makeAddr("treasury");
    bytes32 serviceId;

    function setUp() public {
        passport = new MockPassport();
        passport.setAgent(provider, 42);
        reg = new ArcServiceRegistry(address(passport));
        rail = new ArcPayRail(address(reg), payable(treasury), 50); // 0.50%
        vm.prank(provider);
        serviceId = reg.registerService(1 ether, "https://b/endpoint", "ipfs://meta");
        vm.deal(payer, 10 ether);
    }

    function test_pay_splitsFundsAndEmits() public {
        uint256 provBefore = provider.balance;
        uint256 treBefore = treasury.balance;
        vm.prank(payer);
        bytes32 callId = rail.pay{value: 1 ether}(serviceId);
        assertEq(provider.balance - provBefore, 0.995 ether);
        assertEq(treasury.balance - treBefore, 0.005 ether);
        (address p, bytes32 sid, uint256 amt) = rail.calls(callId);
        assertEq(p, payer);
        assertEq(sid, serviceId);
        assertEq(amt, 1 ether);
    }

    function test_pay_wrongValueReverts() public {
        vm.prank(payer);
        vm.expectRevert(ArcPayRail.WrongValue.selector);
        rail.pay{value: 0.5 ether}(serviceId);
    }

    function test_pay_inactiveServiceReverts() public {
        vm.prank(provider);
        reg.deactivateService(serviceId);
        vm.prank(payer);
        vm.expectRevert(ArcPayRail.ServiceInactive.selector);
        rail.pay{value: 1 ether}(serviceId);
    }

    function test_callIdsAreUnique() public {
        vm.startPrank(payer);
        bytes32 a = rail.pay{value: 1 ether}(serviceId);
        bytes32 b = rail.pay{value: 1 ether}(serviceId);
        vm.stopPrank();
        assertTrue(a != b);
    }
}

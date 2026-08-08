// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ArcServiceRegistry.sol";
import "./mocks/MockPassport.sol";

contract ArcServiceRegistryTest is Test {
    ArcServiceRegistry reg;
    MockPassport passport;
    address provider = makeAddr("provider");

    function setUp() public {
        passport = new MockPassport();
        passport.setAgent(provider, 42);
        reg = new ArcServiceRegistry(address(passport));
    }

    function test_register_bindsAgentAndStores() public {
        vm.prank(provider);
        bytes32 id = reg.registerService(1e16, "https://b/endpoint", "ipfs://meta");
        ArcServiceRegistry.Service memory s = reg.getService(id);
        assertEq(s.provider, provider);
        assertEq(s.agentId, 42);
        assertEq(s.price, 1e16);
        assertEq(s.endpointURI, "https://b/endpoint");
        assertTrue(s.active);
    }

    function test_register_revertsWithoutAgentId() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(ArcServiceRegistry.NoAgentId.selector);
        reg.registerService(1e16, "x", "y");
    }

    function test_register_revertsZeroPrice() public {
        vm.prank(provider);
        vm.expectRevert(ArcServiceRegistry.ZeroPrice.selector);
        reg.registerService(0, "x", "y");
    }

    function test_deactivate_onlyProvider() public {
        vm.prank(provider);
        bytes32 id = reg.registerService(1e16, "x", "y");
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(ArcServiceRegistry.NotProvider.selector);
        reg.deactivateService(id);
        vm.prank(provider);
        reg.deactivateService(id);
        assertFalse(reg.getService(id).active);
    }

    function test_update_onlyProvider() public {
        vm.prank(provider);
        bytes32 id = reg.registerService(1e16, "x", "y");
        vm.prank(provider);
        reg.updateService(id, 2e16, "https://b/v2", "ipfs://meta2");
        ArcServiceRegistry.Service memory s = reg.getService(id);
        assertEq(s.price, 2e16);
        assertEq(s.endpointURI, "https://b/v2");
    }
}

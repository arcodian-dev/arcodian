// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ArcPayVault.sol";

contract ArcPayVaultTest is Test {
    ArcPayVault vault;
    address provider = makeAddr("provider");
    address treasury = makeAddr("treasury");
    address payer;
    uint256 payerPk;

    function setUp() public {
        (payer, payerPk) = makeAddrAndKey("payer");
        vault = new ArcPayVault(payable(treasury), 50); // 0.50%
        vm.deal(payer, 100 ether);
    }

    function _sign(uint256 cumulative) internal view returns (bytes memory) {
        bytes32 typehash = keccak256("Voucher(address payer,address provider,uint256 cumulative)");
        bytes32 structHash = keccak256(abi.encode(typehash, payer, provider, cumulative));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", vault.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _deposit(uint256 amt) internal { vm.prank(payer); vault.deposit{value: amt}(); }
    function _allocate(uint256 amt) internal { vm.prank(payer); vault.allocate(provider, amt); }

    function test_deposit_increasesFree() public {
        _deposit(5 ether);
        assertEq(vault.freeBalance(payer), 5 ether);
    }

    function test_allocate_movesFreeToSub() public {
        _deposit(5 ether);
        _allocate(2 ether);
        assertEq(vault.freeBalance(payer), 3 ether);
        (uint256 allocated, uint256 redeemed,) = vault.subs(payer, provider);
        assertEq(allocated, 2 ether);
        assertEq(redeemed, 0);
    }

    function test_allocate_revertsInsufficientFree() public {
        _deposit(1 ether);
        vm.prank(payer);
        vm.expectRevert(ArcPayVault.InsufficientFree.selector);
        vault.allocate(provider, 2 ether);
    }

    function test_redeem_paysNetOfFeeAndAdvances() public {
        _deposit(5 ether); _allocate(3 ether);
        uint256 provBefore = provider.balance;
        uint256 treBefore = treasury.balance;
        bytes memory sig = _sign(1 ether);
        vm.prank(provider);
        vault.redeem(payer, 1 ether, sig);
        assertEq(provider.balance - provBefore, 0.995 ether);
        assertEq(treasury.balance - treBefore, 0.005 ether);
        (, uint256 redeemed,) = vault.subs(payer, provider);
        assertEq(redeemed, 1 ether);
    }

    function test_redeem_secondVoucherPaysDelta() public {
        _deposit(5 ether); _allocate(3 ether);
        bytes memory sig1 = _sign(1 ether);
        vm.prank(provider); vault.redeem(payer, 1 ether, sig1);
        uint256 provBefore = provider.balance;
        bytes memory sig2 = _sign(3 ether);
        vm.prank(provider); vault.redeem(payer, 3 ether, sig2); // delta 2 ether
        assertEq(provider.balance - provBefore, 1.99 ether); // 2 - 0.5%
    }

    function test_redeem_rejectsBadSignature() public {
        _deposit(5 ether); _allocate(3 ether);
        bytes memory sig = _sign(1 ether);
        vm.prank(provider);
        vm.expectRevert(ArcPayVault.BadSignature.selector);
        vault.redeem(payer, 2 ether, sig);
    }

    function test_redeem_rejectsExceedsAllocated() public {
        _deposit(5 ether); _allocate(1 ether);
        bytes memory sig = _sign(2 ether);
        vm.prank(provider);
        vm.expectRevert(ArcPayVault.ExceedsAllocated.selector);
        vault.redeem(payer, 2 ether, sig);
    }

    function test_redeem_rejectsNonIncreasing() public {
        _deposit(5 ether); _allocate(3 ether);
        bytes memory sig1 = _sign(2 ether);
        vm.prank(provider); vault.redeem(payer, 2 ether, sig1);
        bytes memory sig2 = _sign(2 ether);
        vm.prank(provider);
        vm.expectRevert(ArcPayVault.NotIncreasing.selector);
        vault.redeem(payer, 2 ether, sig2);
    }

    function test_withdrawFree() public {
        _deposit(5 ether); _allocate(2 ether);
        uint256 bal = payer.balance;
        vm.prank(payer); vault.withdrawFree(3 ether);
        assertEq(payer.balance - bal, 3 ether);
        assertEq(vault.freeBalance(payer), 0);
    }

    function test_deallocate_respectsChallengeWindow() public {
        _deposit(5 ether); _allocate(3 ether);
        bytes memory sig = _sign(1 ether);
        vm.prank(provider); vault.redeem(payer, 1 ether, sig);
        vm.prank(payer); vault.requestDeallocate(provider);
        vm.prank(payer);
        vm.expectRevert(ArcPayVault.DeallocateNotReady.selector);
        vault.finalizeDeallocate(provider);
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(payer); vault.finalizeDeallocate(provider);
        assertEq(vault.freeBalance(payer), 4 ether); // 2 leftover free + 2 returned
    }
}

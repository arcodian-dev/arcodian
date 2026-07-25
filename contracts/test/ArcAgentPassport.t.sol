// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import {ArcAgentPassport, IIdentityRegistry} from "../src/ArcAgentPassport.sol";

contract MockIdentity is IIdentityRegistry {
    mapping(uint256=>address) public owners;
    function setOwner(uint256 id,address o) external {owners[id]=o;}
    function ownerOf(uint256 id) external view returns(address){require(owners[id]!=address(0),"no token");return owners[id];}
}

contract ArcAgentPassportTest is Test {
    MockIdentity idreg; ArcAgentPassport pp;
    address alice=address(1); address bob=address(2); address walletA=address(11); address walletB=address(12);
    function setUp() public {idreg=new MockIdentity();pp=new ArcAgentPassport(IIdentityRegistry(address(idreg)));idreg.setOwner(1,alice);idreg.setOwner(2,bob);}

    function testOwnerBindsWallet() public {vm.prank(alice);pp.bindWallet(1,walletA);assertEq(pp.walletOf(1),walletA);assertEq(pp.agentIdOf(walletA),1);}
    function testNonOwnerCannotBind() public {vm.prank(bob);vm.expectRevert(ArcAgentPassport.NotAgentOwner.selector);pp.bindWallet(1,walletA);}
    function testRotationInvalidatesOldWallet() public {vm.startPrank(alice);pp.bindWallet(1,walletA);pp.bindWallet(1,walletB);vm.stopPrank();assertEq(pp.agentIdOf(walletA),0);assertEq(pp.agentIdOf(walletB),1);assertEq(pp.walletOf(1),walletB);}
    function testWalletCannotBeSharedAcrossAgents() public {vm.prank(alice);pp.bindWallet(1,walletA);vm.prank(bob);vm.expectRevert(ArcAgentPassport.WalletTaken.selector);pp.bindWallet(2,walletA);}
    function testUnbindClearsMaps() public {vm.startPrank(alice);pp.bindWallet(1,walletA);pp.unbind(1);vm.stopPrank();assertEq(pp.walletOf(1),address(0));assertEq(pp.agentIdOf(walletA),0);}
    function testFakeAgentIdReverts() public {vm.prank(alice);vm.expectRevert();pp.bindWallet(999,walletA);}
    function testZeroWalletReverts() public {vm.prank(alice);vm.expectRevert(ArcAgentPassport.ZeroWallet.selector);pp.bindWallet(1,address(0));}
}

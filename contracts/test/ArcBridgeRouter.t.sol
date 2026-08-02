// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {ArcBridgeRouter} from "../src/ArcBridgeRouter.sol";

contract MockUsdc {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

// Mirrors the REAL mainnet TokenMessengerV2.depositForBurn signature — no
// return value. An earlier version of this mock returned a fake uint64
// nonce, which let ArcBridgeRouter's matching (also wrong) interface pass
// every test while reverting on every real chain: Solidity's ABI decoder
// choked on the real contract's empty return data. Keep this mock void.
contract MockMessenger {
    MockUsdc immutable token;
    uint256 public burned;
    uint32 public destinationDomain;
    bytes32 public mintRecipient;
    uint256 public maxFee;
    uint32 public minFinalityThreshold;

    constructor(MockUsdc token_) {
        token = token_;
    }

    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain_,
        bytes32 mintRecipient_,
        address burnToken,
        bytes32,
        uint256 maxFee_,
        uint32 minFinalityThreshold_
    ) external {
        require(burnToken == address(token), "TOKEN");
        token.transferFrom(msg.sender, address(0xDEAD), amount);
        burned = amount;
        destinationDomain = destinationDomain_;
        mintRecipient = mintRecipient_;
        maxFee = maxFee_;
        minFinalityThreshold = minFinalityThreshold_;
    }
}

contract ArcBridgeRouterTest is Test {
    MockUsdc token;
    MockMessenger messenger;
    ArcBridgeRouter router;
    address user = address(0xA11CE);
    address treasury = address(0xFEE);

    function setUp() public {
        token = new MockUsdc();
        messenger = new MockMessenger(token);
        router = new ArcBridgeRouter(address(token), address(messenger), treasury);
        token.mint(user, 100_000_000);
        vm.prank(user);
        token.approve(address(router), type(uint256).max);
    }

    function testAtomicallySplitsFeeAndBurnsNet() public {
        bytes32 recipient = bytes32(uint256(uint160(user)));
        vm.prank(user);
        router.bridge(1_000_000, 26, recipient, 10_000, 1000);

        assertEq(token.balanceOf(treasury), 15_000);
        assertEq(messenger.burned(), 985_000);
        assertEq(messenger.destinationDomain(), 26);
        assertEq(messenger.mintRecipient(), recipient);
        assertEq(messenger.maxFee(), 10_000);
        assertEq(messenger.minFinalityThreshold(), 1000);
        assertEq(token.balanceOf(address(router)), 0);
    }

    function testRoundsFeeUpAndNeverUndercharges() public view {
        (uint256 fee, uint256 net) = router.quote(101);
        assertEq(fee, 2);
        assertEq(net, 99);
    }

    function testRejectsDustWhoseFeeConsumesAmount() public {
        vm.prank(user);
        vm.expectRevert(ArcBridgeRouter.FeeConsumesAmount.selector);
        router.bridge(1, 26, bytes32(uint256(uint160(user))), 0, 2000);
    }

    function testConstructorRejectsZeroAddresses() public {
        vm.expectRevert(ArcBridgeRouter.ZeroAddress.selector);
        new ArcBridgeRouter(address(0), address(messenger), treasury);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {PumpToken} from "../src/ArcPump.sol";
import {ArcFxPool, IERC20} from "../src/ArcFxPool.sol";
import {ArcCrossBuyRouter, IArcFxPool} from "../src/ArcCrossBuyRouter.sol";
import {ArcPumpSuiteEurc, ArcPumpFactoryEurc, ArcPumpCurveEurc} from "../src/ArcPumpEurc.sol";

contract MockStable {
    string public symbol;
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory symbol_) {
        symbol = symbol_;
    }

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
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract ArcCrossBuyRouterTest is Test {
    MockStable usdc;
    MockStable eurc;
    ArcFxPool pool;
    ArcCrossBuyRouter router;
    ArcPumpCurveEurc curve;
    PumpToken token;

    address payable treasury = payable(address(0xFEE));
    address buyer = address(0xB0B);

    uint64 constant DEADLINE = 4102444800; // 2100-01-01

    function setUp() public {
        usdc = new MockStable("USDC");
        eurc = new MockStable("EURC");

        // Seed the FX pool at ~0.92 EUR/USD with deep-enough reserves that a
        // 1 USDC swap barely moves the price.
        pool = new ArcFxPool(IERC20(address(usdc)), IERC20(address(eurc)));
        usdc.mint(address(this), 100_000_000000); // 100,000 USDC
        eurc.mint(address(this), 92_000_000000); //  92,000 EURC
        usdc.approve(address(pool), type(uint256).max);
        eurc.approve(address(pool), type(uint256).max);
        pool.seed(100_000_000000, 92_000_000000);

        router = new ArcCrossBuyRouter(IArcFxPool(address(pool)), IERC20(address(usdc)), IERC20(address(eurc)));

        ArcPumpSuiteEurc suite = new ArcPumpSuiteEurc(IERC20(address(eurc)), 4_500_000000, treasury);
        ArcPumpFactoryEurc factory = suite.pumpFactory();
        (address t, address c) = factory.createLaunch("Euro Coin", "EUROC", "ipfs://eurc");
        token = PumpToken(t);
        curve = ArcPumpCurveEurc(c);

        usdc.mint(buyer, 1_000_000000); // 1,000 USDC
        vm.prank(buyer);
        usdc.approve(address(router), type(uint256).max);
    }

    function testCrossBuyDeliversTokensAndLeavesRouterEmpty() public {
        vm.prank(buyer);
        uint256 got = router.buyWithUsdc(address(curve), 100_000000, 1, DEADLINE);

        assertGt(got, 0, "buyer received tokens");
        assertEq(token.balanceOf(buyer), got, "tokens landed with the buyer");
        assertEq(usdc.balanceOf(address(router)), 0, "no USDC left in router");
        assertEq(eurc.balanceOf(address(router)), 0, "no EURC left in router");
        assertEq(token.balanceOf(address(router)), 0, "no tokens left in router");
    }

    function testRevertLeavesBuyerUsdcIntactAndNeverHoldingEurc() public {
        uint256 before = usdc.balanceOf(buyer);
        vm.prank(buyer);
        vm.expectRevert();
        router.buyWithUsdc(address(curve), 100_000000, type(uint128).max, DEADLINE);

        assertEq(usdc.balanceOf(buyer), before, "USDC fully restored");
        assertEq(eurc.balanceOf(buyer), 0, "buyer never holds EURC");
        assertEq(token.balanceOf(buyer), 0, "no tokens delivered");
    }

    function testRejectsExpiredDeadline() public {
        vm.warp(1000);
        vm.prank(buyer);
        vm.expectRevert(bytes("EXPIRED"));
        router.buyWithUsdc(address(curve), 100_000000, 1, uint64(block.timestamp - 1));
    }

    function testRejectsZeroMinTokensOut() public {
        vm.prank(buyer);
        vm.expectRevert(bytes("NO_MIN"));
        router.buyWithUsdc(address(curve), 100_000000, 0, DEADLINE);
    }

    function testRejectsZeroInput() public {
        vm.prank(buyer);
        vm.expectRevert(bytes("ZERO_IN"));
        router.buyWithUsdc(address(curve), 0, 1, DEADLINE);
    }

    function testConstructorRejectsZeroAddresses() public {
        vm.expectRevert(bytes("ZERO_ADDRESS"));
        new ArcCrossBuyRouter(IArcFxPool(address(0)), IERC20(address(usdc)), IERC20(address(eurc)));
    }
}

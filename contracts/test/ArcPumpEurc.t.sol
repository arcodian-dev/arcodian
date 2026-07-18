// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {PumpToken} from "../src/ArcPump.sol";
import {IERC20} from "../src/ArcFxPool.sol";
import {
    ArcPumpSuiteEurc, ArcPumpFactoryEurc, ArcDexFactoryEurc, ArcPumpCurveEurc, ArcDexPairEurc
} from "../src/ArcPumpEurc.sol";

contract MockEurc {
    uint8 public constant decimals = 6;
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
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract ArcPumpEurcTest is Test {
    MockEurc eurc;
    address payable treasury = payable(address(0xFEE));
    address buyer = address(0xB0B);

    function _launch() internal returns (ArcPumpCurveEurc curve, PumpToken token) {
        ArcPumpSuiteEurc suite = new ArcPumpSuiteEurc(IERC20(address(eurc)), 4_500_000000, treasury);
        ArcPumpFactoryEurc factory = suite.pumpFactory();
        (address t, address c) = factory.createLaunch("Euro Coin", "EUROC", "ipfs://eurc");
        token = PumpToken(t);
        curve = ArcPumpCurveEurc(address(c));
    }

    function setUp() public {
        eurc = new MockEurc();
    }

    function testEngineAndQuoteKind() public {
        ArcPumpSuiteEurc suite = new ArcPumpSuiteEurc(IERC20(address(eurc)), 4_500_000000, treasury);
        assertEq(suite.ENGINE_VERSION(), 7);
        assertEq(suite.QUOTE_KIND(), 1);
        assertEq(suite.pumpFactory().QUOTE_KIND(), 1);
    }

    function testBuyPullsEurcAndAccruesFee() public {
        (ArcPumpCurveEurc curve, PumpToken token) = _launch();
        eurc.mint(buyer, 100_000000); // 100 EURC
        vm.startPrank(buyer);
        eurc.approve(address(curve), type(uint256).max);
        uint256 out = curve.buy(100_000000, 1, uint64(block.timestamp + 1));
        vm.stopPrank();
        assertGt(out, 0);
        assertEq(token.balanceOf(buyer), out);
        assertEq(curve.accruedProtocolFees(), 1_000000); // 1% of 100 EURC
        assertEq(curve.realQuoteReserve(), 99_000000);
        assertEq(eurc.balanceOf(address(curve)), 100_000000);
    }

    function testSellReturnsEurc() public {
        (ArcPumpCurveEurc curve, PumpToken token) = _launch();
        eurc.mint(buyer, 100_000000);
        vm.startPrank(buyer);
        eurc.approve(address(curve), type(uint256).max);
        uint256 bought = curve.buy(100_000000, 1, uint64(block.timestamp + 1));
        token.approve(address(curve), bought);
        uint256 eurcBefore = eurc.balanceOf(buyer);
        uint256 out = curve.sell(bought / 2, 1, uint64(block.timestamp + 1));
        vm.stopPrank();
        assertGt(out, 0);
        assertEq(eurc.balanceOf(buyer) - eurcBefore, out);
    }

    function testTreasuryPullWithdrawEurc() public {
        (ArcPumpCurveEurc curve,) = _launch();
        eurc.mint(buyer, 100_000000);
        vm.startPrank(buyer);
        eurc.approve(address(curve), type(uint256).max);
        curve.buy(100_000000, 1, uint64(block.timestamp + 1));
        vm.stopPrank();
        vm.prank(treasury);
        curve.withdrawProtocolFees();
        assertEq(eurc.balanceOf(treasury), 1_000000);
        assertEq(curve.accruedProtocolFees(), 0);
    }

    function testGraduationCreatesEurcPair() public {
        (ArcPumpCurveEurc curve, PumpToken token) = _launch();
        eurc.mint(buyer, 4_600_000000); // 4600 EURC
        vm.startPrank(buyer);
        eurc.approve(address(curve), type(uint256).max);
        curve.buy(4_600_000000, 1, uint64(block.timestamp + 1));
        vm.stopPrank();
        assertTrue(curve.graduated());
        ArcDexPairEurc pair = curve.pair();
        assertEq(curve.accruedProtocolFees(), 46_000000); // 1% of 4600
        // graduated liquidity: 4554 EURC seeded into pair
        assertEq(pair.quoteReserve(), 4_554_000000);
        assertEq(eurc.balanceOf(address(pair)), 4_554_000000);
        assertGt(pair.totalSupply(), 0);
        assertEq(pair.balanceOf(pair.BURN()), pair.totalSupply());
        // LP fully burned; pair now tradable in EURC
        uint256 trBefore = pair.tokenReserve();
        vm.startPrank(buyer);
        eurc.mint(buyer, 10_000000);
        eurc.approve(address(pair), type(uint256).max);
        uint256 outTokens = pair.buy(10_000000, 1, uint64(block.timestamp + 1));
        vm.stopPrank();
        assertGt(outTokens, 0);
        assertLt(pair.tokenReserve(), trBefore);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {ArcStockMarket, ArcSynthStock, IPyth} from "../src/ArcStockMarket.sol";

contract MockPythEquity {
    mapping(bytes32 => IPyth.Price) public prices;
    function set(bytes32 id, int64 price, uint64 conf, uint256 publishTime) external { prices[id] = IPyth.Price(price, conf, -5, publishTime); }
    function getUpdateFee(bytes[] calldata) external pure returns (uint256) { return 0; }
    function updatePriceFeeds(bytes[] calldata) external payable {}
    function getPriceNoOlderThan(bytes32 id, uint256 age) external view returns (IPyth.Price memory p) {
        p = prices[id];
        require(p.publishTime != 0, "PriceFeedNotFound");
        require(block.timestamp - p.publishTime <= age, "StalePrice");
    }
}

contract ArcStockMarketTest is Test {
    MockPythEquity pyth;
    ArcStockMarket market;
    ArcSynthStock nvda;
    bytes32 constant NVDA = bytes32(uint256(1));
    bytes32 constant AAPL = bytes32(uint256(2));
    address treasury = address(0xFEE);
    address lp = address(0x1111);
    address alice = address(0xA11CE);
    bytes[] none;

    function setUp() public {
        vm.warp(1_800_000_000);
        pyth = new MockPythEquity();
        market = new ArcStockMarket(IPyth(address(pyth)), treasury, address(this), address(this));
        (, address t) = market.listAsset("Synthetic NVIDIA", "sNVDA", NVDA, 10_000 ether);
        nvda = ArcSynthStock(t);
        market.listAsset("Synthetic Apple", "sAAPL", AAPL, 10_000 ether);
        _price(NVDA, 180_00000, 5000); // $180.00 ± $0.05
        _price(AAPL, 230_00000, 5000);
        vm.deal(lp, 100_000 ether);
        vm.deal(alice, 100_000 ether);
        vm.prank(lp);
        market.deposit{value: 20_000 ether}(none);
    }

    function _price(bytes32 id, int64 p, uint64 conf) internal { pyth.set(id, p, conf, block.timestamp); }

    function testBuyAtAskPaysFee() public {
        vm.prank(alice);
        uint256 shares = market.buy{value: 1_000 ether}(0, 0, none);
        // (1000 − 0.3%) / 180.05
        assertApproxEqAbs(shares, uint256(997 ether) * 1e18 / 180.05 ether, 1e6);
        assertEq(nvda.balanceOf(alice), shares);
        assertEq(market.treasuryFees(), 0.6 ether, "20% of the 3 USDC fee");
    }

    function testRoundTripCostsFeesAndSpread() public {
        vm.startPrank(alice);
        uint256 before = alice.balance;
        uint256 shares = market.buy{value: 1_000 ether}(0, 0, none);
        market.sell(0, shares, 0, none);
        vm.stopPrank();
        uint256 lost = before - alice.balance;
        assertGt(lost, 6 ether, "two 0.3% fees");
        assertLt(lost, 7 ether, "plus the confidence spread");
    }

    function testGainPaidByPool() public {
        vm.prank(alice);
        uint256 shares = market.buy{value: 1_000 ether}(0, 0, none);
        _price(NVDA, 198_00000, 5000); // +10%
        uint256 before = alice.balance;
        vm.prank(alice);
        market.sell(0, shares, 0, none);
        assertApproxEqRel(alice.balance - before, 1_087 ether, 0.01e18);
    }

    function testStalePriceStopsTrading() public {
        vm.warp(block.timestamp + 61);
        vm.prank(alice);
        vm.expectRevert("StalePrice");
        market.buy{value: 100 ether}(0, 0, none);
    }

    function testWideConfidenceRefused() public {
        _price(NVDA, 180_00000, 300_000); // $3 on $180 = 1.7%
        vm.prank(alice);
        vm.expectRevert(ArcStockMarket.BadPrice.selector);
        market.buy{value: 100 ether}(0, 0, none);
    }

    function testPerAssetCap() public {
        market.setCap(0, 500 ether);
        vm.prank(alice);
        vm.expectRevert(ArcStockMarket.CapExceeded.selector);
        market.buy{value: 1_000 ether}(0, 0, none);
    }

    function testPoolExposureCap() public {
        vm.prank(alice);
        vm.expectRevert(ArcStockMarket.CapExceeded.selector);
        market.buy{value: 11_000 ether}(0, 0, none); // > 50% of a ~31k pool after the deposit
    }

    function testSlippageGuard() public {
        vm.prank(alice);
        vm.expectRevert(ArcStockMarket.Slippage.selector);
        market.buy{value: 100 ether}(0, 1_000 ether, none);
    }

    function testLpEarnsFeesAndLockApplies() public {
        vm.prank(lp);
        vm.expectRevert(ArcStockMarket.Locked.selector);
        market.withdraw(1, none);

        for (uint256 i; i < 5; i++) {
            vm.startPrank(alice);
            uint256 s = market.buy{value: 1_000 ether}(0, 0, none);
            market.sell(0, s, 0, none);
            vm.stopPrank();
        }
        vm.warp(block.timestamp + 1 days);
        _price(NVDA, 180_00000, 5000);
        _price(AAPL, 230_00000, 5000);
        uint256 shares = market.sharesOf(lp);
        uint256 before = lp.balance;
        vm.prank(lp);
        market.withdraw(shares, none);
        assertGt(lp.balance - before, 20_000 ether, "LP got fees on top");
        market.sweepTreasuryFees();
        assertGt(treasury.balance, 0);
    }

    function testLpShareReflectsTraderProfit() public {
        vm.prank(alice);
        market.buy{value: 5_000 ether}(0, 0, none);
        _price(NVDA, 216_00000, 5000); // +20%: the pool now owes alice more
        uint256 nav = market.netAssetValue();
        assertLt(nav, 20_000 ether, "LP value falls when traders win");
    }

    function testDepositNeedsFreshPricesWhenOpenInterest() public {
        vm.prank(alice);
        market.buy{value: 1_000 ether}(0, 0, none);
        vm.warp(block.timestamp + 2 hours); // market closed, prices stale
        vm.prank(lp);
        vm.expectRevert("StalePrice");
        market.deposit{value: 1 ether}(none);
    }

    function testFirstDepositMinimumAndDeadShares() public {
        ArcStockMarket fresh = new ArcStockMarket(IPyth(address(pyth)), treasury, address(this), address(this));
        vm.prank(lp);
        vm.expectRevert(ArcStockMarket.Invalid.selector);
        fresh.deposit{value: 0.5 ether}(none);
        vm.prank(lp);
        fresh.deposit{value: 1 ether}(none);
        assertEq(fresh.totalShares(), 1 ether);
        assertEq(fresh.sharesOf(lp), 1 ether - 1e15);
        vm.prank(alice);
        uint256 s = fresh.deposit{value: 3 ether}(none);
        assertEq(s, 3 ether, "second depositor priced at NAV, no rounding loss");
    }

    function testLpLockIsFifteenMinutes() public {
        vm.prank(lp);
        vm.expectRevert(ArcStockMarket.Locked.selector);
        market.withdraw(1, none);
        vm.warp(block.timestamp + 15 minutes);
        _price(NVDA, 180_00000, 5000);
        _price(AAPL, 230_00000, 5000);
        uint256 shares = market.sharesOf(lp);
        vm.prank(lp);
        market.withdraw(shares, none);
        assertEq(market.sharesOf(lp), 0);
    }

    function testOnlyMarketMints() public {
        vm.expectRevert(ArcSynthStock.NotMarket.selector);
        nvda.mint(address(this), 1);
    }

    function testPauseAndAdmin() public {
        market.setPaused(true);
        vm.prank(alice);
        vm.expectRevert(ArcStockMarket.IsPaused.selector);
        market.buy{value: 1 ether}(0, 0, none);
        vm.prank(alice);
        vm.expectRevert(ArcStockMarket.Unauthorized.selector);
        market.listAsset("x", "x", bytes32(uint256(9)), 1);
    }
}

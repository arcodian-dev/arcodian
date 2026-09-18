// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {ArcSignedPriceFeed} from "../src/ArcSignedPriceFeed.sol";
import {ArcStockMarket, ArcSynthStock, IPyth} from "../src/ArcStockMarket.sol";

contract ArcSignedPriceFeedTest is Test {
    ArcSignedPriceFeed feed;
    ArcStockMarket market;
    uint256 constant SIGNER_KEY = 0xA11CE5;
    address signer;
    bytes32 constant NVDA = keccak256("Equity.US.NVDA/USD");
    address lp = address(0x1111);
    address alice = address(0xA11CE);

    function setUp() public {
        vm.warp(1_800_000_000);
        signer = vm.addr(SIGNER_KEY);
        feed = new ArcSignedPriceFeed(address(this), signer);
        market = new ArcStockMarket(IPyth(address(feed)), address(0xFEE), address(this), address(this));
        market.listAsset("Arcodian NVIDIA", "aNVDA", NVDA, 10_000 ether);
        vm.deal(lp, 10_000 ether);
        vm.deal(alice, 10_000 ether);
    }

    function _update(uint256 key, bytes32 id, int64 price, uint64 conf, uint64 at) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, feed.digest(id, price, conf, -5, at));
        return abi.encode(id, price, conf, int32(-5), at, v, r, s);
    }

    function _bundle(bytes memory u) internal pure returns (bytes[] memory b) {
        b = new bytes[](1);
        b[0] = u;
    }

    function testStoresSignedPrice() public {
        feed.updatePriceFeeds(_bundle(_update(SIGNER_KEY, NVDA, 180_00000, 5000, uint64(block.timestamp))));
        IPyth.Price memory p = feed.getPriceNoOlderThan(NVDA, 60);
        assertEq(p.price, 180_00000);
        assertEq(p.conf, 5000);
        assertEq(p.expo, -5);
    }

    function testRejectsWrongSigner() public {
        bytes[] memory b = _bundle(_update(0xBAD, NVDA, 1, 0, uint64(block.timestamp)));
        vm.expectRevert(ArcSignedPriceFeed.BadSignature.selector);
        feed.updatePriceFeeds(b);
    }

    function testRejectsTamperedPrice() public {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, feed.digest(NVDA, 180_00000, 5000, -5, uint64(block.timestamp)));
        bytes[] memory b = _bundle(abi.encode(NVDA, int64(1_00000), uint64(5000), int32(-5), uint64(block.timestamp), v, r, s));
        vm.expectRevert(ArcSignedPriceFeed.BadSignature.selector);
        feed.updatePriceFeeds(b);
    }

    function testRejectsSignatureForAnotherFeedContract() public {
        ArcSignedPriceFeed other = new ArcSignedPriceFeed(address(this), signer);
        bytes[] memory b = _bundle(_update(SIGNER_KEY, NVDA, 180_00000, 5000, uint64(block.timestamp)));
        vm.expectRevert(ArcSignedPriceFeed.BadSignature.selector);
        other.updatePriceFeeds(b);
    }

    function testOlderUpdateDoesNotOverwrite() public {
        feed.updatePriceFeeds(_bundle(_update(SIGNER_KEY, NVDA, 180_00000, 5000, uint64(block.timestamp))));
        feed.updatePriceFeeds(_bundle(_update(SIGNER_KEY, NVDA, 100_00000, 5000, uint64(block.timestamp - 5))));
        assertEq(feed.getPriceUnsafe(NVDA).price, 180_00000);
    }

    function testFutureAndStale() public {
        bytes[] memory future = _bundle(_update(SIGNER_KEY, NVDA, 180_00000, 5000, uint64(block.timestamp + 60)));
        vm.expectRevert(ArcSignedPriceFeed.FromFuture.selector);
        feed.updatePriceFeeds(future);

        feed.updatePriceFeeds(_bundle(_update(SIGNER_KEY, NVDA, 180_00000, 5000, uint64(block.timestamp))));
        vm.warp(block.timestamp + 61);
        vm.expectRevert(ArcSignedPriceFeed.StalePrice.selector);
        feed.getPriceNoOlderThan(NVDA, 60);
    }

    function testSignerRotation() public {
        feed.setSigner(vm.addr(0xB0B));
        bytes[] memory b = _bundle(_update(SIGNER_KEY, NVDA, 180_00000, 5000, uint64(block.timestamp)));
        vm.expectRevert(ArcSignedPriceFeed.BadSignature.selector);
        feed.updatePriceFeeds(b);
        vm.prank(alice);
        vm.expectRevert(ArcSignedPriceFeed.Unauthorized.selector);
        feed.setSigner(alice);
    }

    function testFullTradeThroughMarket() public {
        bytes[] memory none;
        vm.prank(lp);
        market.deposit{value: 5_000 ether}(none);

        bytes[] memory b = _bundle(_update(SIGNER_KEY, NVDA, 180_00000, 5000, uint64(block.timestamp)));
        vm.prank(alice);
        uint256 shares = market.buy{value: 100 ether}(0, 0, b);
        assertGt(shares, 0);

        vm.warp(block.timestamp + 30);
        bytes[] memory up = _bundle(_update(SIGNER_KEY, NVDA, 198_00000, 5000, uint64(block.timestamp)));
        uint256 before = alice.balance;
        vm.prank(alice);
        market.sell(0, shares, 0, up);
        assertApproxEqRel(alice.balance - before, 108.7 ether, 0.01e18);
    }
}

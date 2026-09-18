// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {ArcStockMarket, ArcSynthStock, IPyth} from "../src/ArcStockMarket.sol";
import {ArcSignedPriceFeed} from "../src/ArcSignedPriceFeed.sol";

/// Arc Mainnet: the stock market on Arcodian's own signed price feed.
///
/// Pyth's equity feeds need a paid entitlement, so prices come from
/// ArcSignedPriceFeed instead: the median of independent public quotes, signed
/// by the price service (scripts/stock-price-signer.mjs). The feed has Pyth's
/// interface, so this is the same ArcStockMarket with the same Pyth feed ids;
/// moving to Pyth later means pointing a new market at Pyth.
///
/// Env: STOCK_SIGNER (the price service's address; holds no funds).
contract DeployArcStockMarketSignedMainnet is Script {
    address constant TREASURY = 0xF1CBe360b45F2E22Ab74A2c434e5602f66105CaF;
    uint256 constant CAP = 250 ether;

    function run() external returns (ArcSignedPriceFeed feed, ArcStockMarket market) {
        require(block.chainid == 5042, "NOT_ARC_MAINNET");
        address signer = vm.envAddress("STOCK_SIGNER");
        vm.startBroadcast();
        feed = new ArcSignedPriceFeed(msg.sender, signer);
        market = new ArcStockMarket(IPyth(address(feed)), TREASURY, msg.sender, msg.sender);
        market.listAsset("Arcodian NVIDIA", "aNVDA", 0xb1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593, CAP);
        market.listAsset("Arcodian Apple", "aAAPL", 0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688, CAP);
        market.listAsset("Arcodian Tesla", "aTSLA", 0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1, CAP);
        market.listAsset("Arcodian S&P 500 ETF", "aSPY", 0x19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5, CAP);
        market.listAsset("Arcodian Nasdaq-100 ETF", "aQQQ", 0x9695e2b96ea7b3859da9ed25b7a46a920a776e2fdae19a7bcfdf2b219230452d, CAP);
        market.listAsset("Arcodian Microsoft", "aMSFT", 0xd0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1, CAP);
        market.listAsset("Arcodian Amazon", "aAMZN", 0xb5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a, CAP);
        market.listAsset("Arcodian Alphabet", "aGOOGL", 0x5a48c03e9b9cb337801073ed9d166817473697efff0d138874e0f6a33d6d5aa6, CAP);
        market.listAsset("Arcodian Meta", "aMETA", 0x78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe, CAP);
        market.listAsset("Arcodian Coinbase", "aCOIN", 0xfee33f2a978bf32dd6b662b65ba8083c6773b494f8401194ec1870c640860245, CAP);
        vm.stopBroadcast();

        require(market.assetCount() == 10, "ASSETS");
        require(feed.signer() == signer, "SIGNER");
        console2.log("ArcSignedPriceFeed", address(feed));
        console2.log("ArcStockMarket    ", address(market));
        for (uint256 i; i < 10; i++) {
            (ArcSynthStock token,,,) = market.assets(i);
            console2.log(i, address(token));
        }
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {ArcLendV2, IERC20Collateral, IArcPriceOracle} from "../src/ArcLendV2.sol";
import {ArcEurUsdOracle, IUniswapV3PoolOracle, IPythPriceUnsafe} from "../src/ArcEurUsdOracle.sol";

/// Arc Mainnet: the EUR/USD oracle and the isolated USDC lending market that
/// reads it. Suppliers lend native USDC and earn the borrow interest; borrowers
/// post Circle's EURC; 10% of all interest accrues to the protocol reserve.
///
/// Launched with small caps (5,000 USDC supply / 3,000 USDC borrow): the
/// oracle's primary source is a Uniswap V3 TWAP, and a cap far below what it
/// would cost to hold that pool off-market for 30 minutes is the guard.
/// Raising a cap later goes through ArcLendV2's 48-hour cap delay.
contract DeployArcLendMainnet is Script {
    address constant USDC = 0x3600000000000000000000000000000000000000;
    address constant EURC = 0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1;
    /// Deepest USDC/EURC pool on Arc (external Uniswap V3 factory, 0.05% tier).
    address constant POOL = 0x6fd5F2fb831940DcD61A98c5B3aCB7D8C6f3bFc1;
    /// Official Pyth on Arc Mainnet (ERC1967 proxy, version 1.4.6).
    address constant PYTH = 0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a;
    bytes32 constant EUR_USD = 0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b;

    function run() external returns (ArcEurUsdOracle oracle, ArcLendV2 market) {
        require(block.chainid == 5042, "NOT_ARC_MAINNET");
        vm.startBroadcast();
        oracle = new ArcEurUsdOracle(IUniswapV3PoolOracle(POOL), USDC, EURC, 30 minutes, IPythPriceUnsafe(PYTH), EUR_USD, 1 hours, 150);
        market = new ArcLendV2(
            IERC20Collateral(EURC),
            IArcPriceOracle(address(oracle)),
            msg.sender, // admin
            msg.sender, // guardian (pause)
            5_000 ether, // supply cap, native USDC (18 dp)
            3_000 ether, // borrow cap
            0.01e18, // 1% base borrow rate
            0.10e18, // +10% up to the kink
            2e18, // +200% above it
            0.8e18, // kink at 80% utilization
            6 hours // max age of the synced price; the keeper syncs every 20 minutes
        );
        vm.stopBroadcast();

        (uint256 price,) = oracle.price();
        require(price > 1e18 && price < 1.3e18, "ORACLE_OUT_OF_RANGE");
        require(market.lastGoodPrice() == price, "MARKET_PRICE");
        console2.log("ArcEurUsdOracle", address(oracle));
        console2.log("ArcLendV2      ", address(market));
        console2.log("USD per EURC   ", price);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import {ArcPythOracle, IPythArc} from "../src/ArcPythOracle.sol";

contract MockPythArc is IPythArc {
    Price internal report;

    function set(int64 p, uint64 c, int32 e, uint256 t) external {
        report = Price(p, c, e, t);
    }

    function getPriceUnsafe(bytes32) external view returns (Price memory) {
        return report;
    }
}

contract ArcPythOracleTest is Test {
    MockPythArc pyth;
    ArcPythOracle adapter;

    function setUp() public {
        pyth = new MockPythArc();
        adapter = new ArcPythOracle(pyth, bytes32(uint256(1)), 100);
    }

    function testNormalizesEurUsdToWad() public {
        pyth.set(108_765, 100, -5, 1234);
        (uint256 value, uint64 updatedAt) = adapter.price();
        assertEq(value, 1.08765 ether);
        assertEq(updatedAt, 1234);
    }

    function testRejectsWideConfidence() public {
        pyth.set(100_000, 1_001, -5, 1234);
        vm.expectRevert(ArcPythOracle.ConfidenceTooWide.selector);
        adapter.price();
    }

    function testRejectsNegativeAndMalformedReports() public {
        pyth.set(-1, 0, -5, 1234);
        vm.expectRevert(ArcPythOracle.InvalidPrice.selector);
        adapter.price();
        pyth.set(100_000, 1, -19, 1234);
        vm.expectRevert(ArcPythOracle.InvalidPrice.selector);
        adapter.price();
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {ArcEurUsdOracle, IUniswapV3PoolOracle, IPythPriceUnsafe} from "../src/ArcEurUsdOracle.sol";
import {ArcLendV2} from "../src/ArcLendV2.sol";
import {IERC20Collateral, IArcPriceOracle} from "../src/ArcLend.sol";

interface IApprove { function approve(address, uint256) external returns (bool); }

contract MockV3Pool {
    address public token0;
    address public token1;
    int56 public cumulativeNow;
    int24 public tick;
    constructor(address t0, address t1, int24 tick_) { token0 = t0; token1 = t1; tick = tick_; }
    function observe(uint32[] calldata ago) external view returns (int56[] memory c, uint160[] memory s) {
        c = new int56[](2); s = new uint160[](2);
        c[0] = -int56(tick) * int56(uint56(ago[0]));
        c[1] = 0;
    }
}

contract MockPyth {
    IPythPriceUnsafe.Price public report;
    bool public exists;
    function set(int64 price, uint64 conf, int32 expo, uint256 publishTime) external {
        report = IPythPriceUnsafe.Price(price, conf, expo, publishTime);
        exists = true;
    }
    function getPriceUnsafe(bytes32) external view returns (IPythPriceUnsafe.Price memory) {
        require(exists, "PriceFeedNotFound");
        return report;
    }
}

/// Unit tests: TWAP math for both token orderings, and Pyth as a cross-check.
contract ArcEurUsdOracleTest is Test {
    address constant USDC = address(0x3600000000000000000000000000000000000000);
    address constant EURC = address(0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1);
    MockPyth pyth;

    function setUp() public { pyth = new MockPyth(); vm.warp(1_800_000_000); }

    // EUR/USD 1.15: EURC per USDC = 0.8696 → tick ≈ ln(0.8696)/ln(1.0001) ≈ -1398.
    function _oracle(bool eurcFirst, int24 tick) internal returns (ArcEurUsdOracle) {
        MockV3Pool p = eurcFirst ? new MockV3Pool(EURC, USDC, -tick) : new MockV3Pool(USDC, EURC, tick);
        return new ArcEurUsdOracle(IUniswapV3PoolOracle(address(p)), USDC, EURC, 1800, IPythPriceUnsafe(address(pyth)), bytes32(uint256(1)), 1 hours, 150);
    }

    function testTwapUsdcIsToken0() public {
        (uint256 v,) = _oracle(false, -1398).price();
        assertApproxEqRel(v, 1.15e18, 0.001e18);
    }

    function testTwapEurcIsToken0() public {
        (uint256 v,) = _oracle(true, -1398).price();
        assertApproxEqRel(v, 1.15e18, 0.001e18);
    }

    function testUsesPythWhenFreshAndAgreeing() public {
        ArcEurUsdOracle o = _oracle(false, -1398);
        pyth.set(115_300, 10, -5, block.timestamp - 60);
        (uint256 v,) = o.price();
        assertEq(v, 1.153e18);
    }

    function testRevertsWhenSourcesDisagree() public {
        ArcEurUsdOracle o = _oracle(false, -1398);
        pyth.set(120_000, 10, -5, block.timestamp - 60); // 4% away from the TWAP
        vm.expectRevert();
        o.price();
    }

    function testIgnoresStalePyth() public {
        ArcEurUsdOracle o = _oracle(false, -1398);
        pyth.set(200_000, 10, -5, block.timestamp - 2 hours);
        (uint256 v,) = o.price();
        assertApproxEqRel(v, 1.15e18, 0.001e18);
    }

    function testRejectsWrongPool() public {
        MockV3Pool p = new MockV3Pool(USDC, address(0xBEEF), 0);
        vm.expectRevert(ArcEurUsdOracle.Invalid.selector);
        new ArcEurUsdOracle(IUniswapV3PoolOracle(address(p)), USDC, EURC, 1800, IPythPriceUnsafe(address(pyth)), bytes32(0), 1 hours, 150);
    }
}

/// Fork test against Arc Mainnet: the real Uniswap V3 USDC/EURC pool and the
/// real Pyth deployment, feeding a real ArcLendV2 through a full
/// supply → collateral → borrow → repay cycle. Skipped unless ARC_FORK_RPC is set.
contract ArcEurUsdOracleForkTest is Test {
    address constant USDC = 0x3600000000000000000000000000000000000000;
    address constant EURC = 0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1;
    address constant POOL = 0x6fd5F2fb831940DcD61A98c5B3aCB7D8C6f3bFc1;
    address constant PYTH = 0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a;
    bytes32 constant EUR_USD = 0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b;

    function testForkOracleAndLendCycle() public {
        string memory rpc = vm.envOr("ARC_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);

        ArcEurUsdOracle oracle = new ArcEurUsdOracle(IUniswapV3PoolOracle(POOL), USDC, EURC, 1800, IPythPriceUnsafe(PYTH), EUR_USD, 1 hours, 150);
        (uint256 p,) = oracle.price();
        emit log_named_decimal_uint("USD per EURC", p, 18);
        assertGt(p, 1.0e18);
        assertLt(p, 1.3e18);

        ArcLendV2 lend = new ArcLendV2(IERC20Collateral(EURC), IArcPriceOracle(address(oracle)), address(this), address(this),
            5_000 ether, 3_000 ether, 0.01e18, 0.10e18, 2e18, 0.8e18, 6 hours);

        address supplier = address(0x5155);
        address borrower = address(0xB0B);
        vm.deal(supplier, 1_000 ether);
        vm.prank(supplier);
        lend.supply{value: 1_000 ether}();

        deal(EURC, borrower, 100e6);
        vm.startPrank(borrower);
        IApprove(EURC).approve(address(lend), 100e6);
        lend.depositCollateral(100e6);
        uint256 maxBorrow = 100 * p * 70 / 100; // 70% LTV, 18 dp
        lend.borrow(maxBorrow * 99 / 100);
        vm.expectRevert();
        lend.borrow(maxBorrow * 2 / 100);
        vm.stopPrank();

        vm.warp(block.timestamp + 30 days);
        lend.syncOracle();
        uint256 principal = maxBorrow * 99 / 100;
        vm.deal(borrower, principal * 2);
        uint256 before = borrower.balance;
        vm.prank(borrower);
        lend.repay{value: principal * 2}(borrower); // accrues, repays in full, refunds the rest
        uint256 paid = before - borrower.balance;
        assertGt(paid, principal, "interest accrued over 30 days");
        assertEq(lend.debtOf(borrower), 0);
        assertGt(lend.reserves(), 0, "protocol fee from interest");
    }
}

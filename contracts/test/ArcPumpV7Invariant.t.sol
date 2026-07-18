// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "forge-std/StdInvariant.sol";
import {PumpToken} from "../src/ArcPump.sol";
import {ArcDexFactoryV7, ArcDexPairV7, ArcPumpFactoryV7, ArcPumpCurveV7} from "../src/ArcPumpV7.sol";

contract CurveV7Handler is Test {
    ArcPumpCurveV7 public immutable curve;
    PumpToken public immutable token;

    constructor(ArcPumpCurveV7 curve_, PumpToken token_) {
        curve = curve_;
        token = token_;
        token.approve(address(curve_), type(uint256).max);
        vm.deal(address(this), 100_000 ether);
    }

    receive() external payable {}

    function buy(uint96 seed) external {
        uint256 amount = bound(uint256(seed), 1e12, 25 ether);
        if (address(this).balance < amount) return;
        curve.buy{value: amount}(1, uint64(block.timestamp + 1));
    }

    function sell(uint96 seed) external {
        uint256 balance = token.balanceOf(address(this));
        if (balance == 0 || curve.realNativeReserve() == 0) return;
        uint256 amount = bound(uint256(seed), 1, balance);
        curve.sell(amount, 1, uint64(block.timestamp + 1));
    }
}

contract ArcPumpV7InvariantTest is StdInvariant, Test {
    ArcPumpCurveV7 internal curve;
    PumpToken internal token;
    CurveV7Handler internal handler;

    function setUp() public {
        ArcDexFactoryV7 dex = new ArcDexFactoryV7(payable(address(this)));
        ArcPumpFactoryV7 factory = new ArcPumpFactoryV7(dex, payable(address(this)), 1_000_000 ether);
        dex.setPumpFactory(address(factory));
        (address tokenAddress, address curveAddress) = factory.createLaunch("Invariant", "INV", "ipfs://invariant");
        token = PumpToken(tokenAddress);
        curve = ArcPumpCurveV7(payable(curveAddress));
        handler = new CurveV7Handler(curve, token);
        targetContract(address(handler));
    }

    receive() external payable {}

    function invariantNativeAccountingIsExact() public view {
        assertEq(address(curve).balance, curve.realNativeReserve() + curve.accruedProtocolFees());
    }

    function invariantTokenSupplyIsConserved() public view {
        assertEq(token.balanceOf(address(curve)) + token.balanceOf(address(handler)), token.totalSupply());
    }

    function invariantCurveRemainsOpenBelowThreshold() public view {
        assertFalse(curve.graduated());
    }
}

contract DexV7Handler is Test {
    ArcDexPairV7 public immutable pair;
    PumpToken public immutable token;

    constructor(ArcDexPairV7 pair_, PumpToken token_) {
        pair = pair_;
        token = token_;
        token.approve(address(pair_), type(uint256).max);
        vm.deal(address(this), 100_000 ether);
    }

    receive() external payable {}

    function buy(uint96 seed) external {
        uint256 amount = bound(uint256(seed), 1e12, 5 ether);
        if (address(this).balance < amount) return;
        try pair.buy{value: amount}(1, uint64(block.timestamp + 1)) {} catch {}
    }

    function sell(uint96 seed) external {
        uint256 balance = token.balanceOf(address(this));
        if (balance == 0) return;
        uint256 amount = bound(uint256(seed), 1, balance);
        try pair.sell(amount, 1, uint64(block.timestamp + 1)) {} catch {}
    }
}

contract ArcDexV7InvariantTest is StdInvariant, Test {
    ArcDexPairV7 internal pair;
    PumpToken internal token;
    DexV7Handler internal handler;

    function setUp() public {
        ArcDexFactoryV7 dex = new ArcDexFactoryV7(payable(address(this)));
        ArcPumpFactoryV7 factory = new ArcPumpFactoryV7(dex, payable(address(this)), 4_500 ether);
        dex.setPumpFactory(address(factory));
        (address tokenAddress, address curveAddress) = factory.createLaunch("DEX Invariant", "DINV", "ipfs://dex");
        token = PumpToken(tokenAddress);
        ArcPumpCurveV7 curve = ArcPumpCurveV7(payable(curveAddress));
        vm.deal(address(this), 5_000 ether);
        curve.buy{value: 4_600 ether}(1, uint64(block.timestamp + 1));
        pair = curve.pair();
        handler = new DexV7Handler(pair, token);
        assertTrue(token.transfer(address(handler), token.balanceOf(address(this))));
        targetContract(address(handler));
    }

    receive() external payable {}

    function invariantNativeAccountingIsExact() public view {
        assertEq(address(pair).balance, pair.nativeReserve() + pair.accruedProtocolFees());
    }

    function invariantTokenSupplyIsConserved() public view {
        assertEq(token.balanceOf(address(pair)) + token.balanceOf(address(handler)), token.totalSupply());
    }

    function invariantAllLiquidityIsBurned() public view {
        assertGt(pair.totalSupply(), 0);
        assertEq(pair.balanceOf(pair.BURN()), pair.totalSupply());
    }
}

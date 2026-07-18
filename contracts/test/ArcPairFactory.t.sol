// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {ArcPair} from "../src/ArcPair.sol";
import {ArcPairFactory} from "../src/ArcPairFactory.sol";

contract FactoryMockToken {
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        uint256 x = allowance[f][msg.sender];
        if (x != type(uint256).max) allowance[f][msg.sender] = x - a;
        balanceOf[f] -= a; balanceOf[t] += a; return true;
    }
}

contract ArcPairFactoryTest is Test {
    ArcPairFactory factory;
    FactoryMockToken tokenA;
    FactoryMockToken tokenB;
    address treasury = address(0xFEE);

    function setUp() public {
        factory = new ArcPairFactory(treasury);
        tokenA = new FactoryMockToken();
        tokenB = new FactoryMockToken();
    }

    function testCreatePairIsOrderIndependent() public {
        address p1 = factory.createPair(address(tokenA), address(tokenB), 30);
        assertEq(factory.getPair(address(tokenA), address(tokenB), 30), p1);
        assertEq(factory.getPair(address(tokenB), address(tokenA), 30), p1, "same pair either way");
    }

    function testDuplicatePairReverts() public {
        factory.createPair(address(tokenA), address(tokenB), 30);
        vm.expectRevert(bytes("PAIR_EXISTS"));
        factory.createPair(address(tokenB), address(tokenA), 30);
    }

    function testBothTiersCoexistAsSeparateMarkets() public {
        address volatilePair = factory.createPair(address(tokenA), address(tokenB), 30);
        address stablePair = factory.createPair(address(tokenA), address(tokenB), 10);
        assertTrue(volatilePair != stablePair, "tiers are separate markets");
        assertEq(ArcPair(volatilePair).feeBps(), 30);
        assertEq(ArcPair(stablePair).feeBps(), 10);
        assertEq(factory.allPairsLength(), 2);
    }

    function testRejectsUnsupportedTier() public {
        vm.expectRevert(bytes("BAD_FEE_TIER"));
        factory.createPair(address(tokenA), address(tokenB), 25);
    }

    function testRejectsIdenticalTokens() public {
        vm.expectRevert(bytes("IDENTICAL"));
        factory.createPair(address(tokenA), address(tokenA), 30);
    }

    function testPairInheritsFactoryTreasury() public {
        address pair = factory.createPair(address(tokenA), address(tokenB), 30);
        assertEq(ArcPair(pair).treasury(), treasury);
    }
}

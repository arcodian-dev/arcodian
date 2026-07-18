// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {ArcPair} from "../src/ArcPair.sol";
import {ArcPairFactory} from "../src/ArcPairFactory.sol";
import {ArcRouter} from "../src/ArcRouter.sol";

contract RouterMockToken {
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

contract ArcRouterTest is Test {
    ArcPairFactory factory;
    ArcRouter router;
    RouterMockToken tokenA;
    RouterMockToken tokenB;
    RouterMockToken tokenC;

    address treasury = address(0xFEE);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    uint64 constant DEADLINE = 4102444800;

    function setUp() public {
        factory = new ArcPairFactory(treasury);
        router = new ArcRouter(factory);
        tokenA = new RouterMockToken();
        tokenB = new RouterMockToken();
        tokenC = new RouterMockToken();

        _seedPair(address(tokenA), address(tokenB));
        _seedPair(address(tokenB), address(tokenC));

        tokenA.mint(bob, 1000 ether);
        vm.prank(bob);
        tokenA.approve(address(router), type(uint256).max);
    }

    function _seedPair(address x, address y) internal {
        address pair = factory.createPair(x, y, 30);
        RouterMockToken(x).mint(alice, 10_000 ether);
        RouterMockToken(y).mint(alice, 10_000 ether);
        vm.startPrank(alice);
        RouterMockToken(x).approve(pair, type(uint256).max);
        RouterMockToken(y).approve(pair, type(uint256).max);
        // Both sides are seeded equally, so token0/token1 ordering does not
        // change the amounts passed here.
        ArcPair(pair).addLiquidity(1000 ether, 1000 ether, 1, DEADLINE);
        vm.stopPrank();
    }

    function _path3() internal view returns (address[] memory path) {
        path = new address[](3);
        path[0] = address(tokenA);
        path[1] = address(tokenB);
        path[2] = address(tokenC);
    }

    function testMultiHopSwapDeliversTokenC() public {
        vm.prank(bob);
        uint256 out = router.swapExactTokensForTokens(_path3(), 100 ether, 1, DEADLINE);

        assertGt(out, 0, "bob received token C");
        assertEq(tokenC.balanceOf(bob), out);
        assertEq(tokenB.balanceOf(bob), 0, "no intermediate token retained");
    }

    function testRouterHoldsNothingAfterSwap() public {
        vm.prank(bob);
        router.swapExactTokensForTokens(_path3(), 100 ether, 1, DEADLINE);

        assertEq(tokenA.balanceOf(address(router)), 0);
        assertEq(tokenB.balanceOf(address(router)), 0);
        assertEq(tokenC.balanceOf(address(router)), 0);
    }

    function testSlippageIsCheckedOnFinalOutputOnly() public {
        vm.prank(bob);
        vm.expectRevert(bytes("SLIPPAGE"));
        router.swapExactTokensForTokens(_path3(), 100 ether, type(uint128).max, DEADLINE);
    }

    function testRejectsShortPath() public {
        address[] memory path = new address[](1);
        path[0] = address(tokenA);
        vm.prank(bob);
        vm.expectRevert(bytes("BAD_PATH"));
        router.swapExactTokensForTokens(path, 100 ether, 1, DEADLINE);
    }

    function testRejectsMissingPair() public {
        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenC); // never created
        vm.prank(bob);
        vm.expectRevert(bytes("NO_PAIR"));
        router.swapExactTokensForTokens(path, 100 ether, 1, DEADLINE);
    }
}

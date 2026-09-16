// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {PumpToken} from "../src/ArcPump.sol";
import {ArcodianLaunchHook} from "../src/ArcodianLaunchHook.sol";
import {ArcodianLaunchFactoryV12} from "../src/ArcodianLaunchFactoryV12.sol";
import {ArcodianV4Router} from "../src/ArcodianV4Router.sol";

contract RouterQuote {
    string public name = "USD Coin";
    string public symbol = "USDC";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { balanceOf[msg.sender] -= a; balanceOf[to] += a; return true; }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        uint256 x = allowance[f][msg.sender];
        if (x != type(uint256).max) allowance[f][msg.sender] = x - a;
        balanceOf[f] -= a; balanceOf[t] += a; return true;
    }
}

/// The full product path on a real PoolManager: launch on V12, quote, buy,
/// sell back — through the router arcodian.fun itself will use.
contract ArcodianV4RouterTest is Test {
    PoolManager manager;
    ArcodianLaunchHook hook;
    ArcodianLaunchFactoryV12 factory;
    ArcodianV4Router router;
    RouterQuote usdc;
    PumpToken token;
    PoolKey key;
    bool tokenIsZero;

    address payable treasury = payable(address(0xFEE));
    address creator = address(0xC0FFEE);
    address trader = address(0xB0B);

    function setUp() public {
        manager = new PoolManager(address(this));
        usdc = new RouterQuote();
        address flagged = address(uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG) | uint160(0x9999 << 20));
        deployCodeTo("ArcodianLaunchHook.sol:ArcodianLaunchHook", abi.encode(manager, address(this), treasury), flagged);
        hook = ArcodianLaunchHook(flagged);
        factory = new ArcodianLaunchFactoryV12(manager, hook, Currency.wrap(address(usdc)), treasury);
        hook.setFactory(address(factory));
        router = new ArcodianV4Router(manager);

        vm.prank(creator);
        (address t,) = factory.createLaunch("Arc Bee", "ARCBEE", "");
        token = PumpToken(t);
        tokenIsZero = t < address(usdc);
        key = PoolKey({
            currency0: tokenIsZero ? Currency.wrap(t) : Currency.wrap(address(usdc)),
            currency1: tokenIsZero ? Currency.wrap(address(usdc)) : Currency.wrap(t),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });

        usdc.mint(trader, 10_000e6);
        vm.startPrank(trader);
        usdc.approve(address(router), type(uint256).max);
        token.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    /// Buying the token spends the quote, which is currency0 only when the
    /// token is not.
    function _buyDirection() internal view returns (bool) { return !tokenIsZero; }

    function testQuoteMatchesTheActualBuy() public {
        uint256 quoted = router.quoteExactInputSingle(key, _buyDirection(), 50e6);
        assertGt(quoted, 0, "quote returns tokens");
        vm.prank(trader);
        uint256 got = router.swapExactInputSingle(key, _buyDirection(), 50e6, quoted, block.timestamp + 60);
        assertEq(got, quoted, "quote is exact, fee included");
        assertEq(token.balanceOf(trader), got);
        assertEq(usdc.balanceOf(trader), 10_000e6 - 50e6, "paid exactly the input");
    }

    function testABuyThroughTheRouterStillPaysTheLaunchFee() public {
        vm.prank(trader);
        router.swapExactInputSingle(key, _buyDirection(), 100e6, 0, block.timestamp + 60);
        Currency quote = Currency.wrap(address(usdc));
        assertEq(hook.claimable(creator, quote) + hook.claimable(treasury, quote), 1e6, "1% of 100 USDC");
    }

    function testBuyThenSellBack() public {
        vm.startPrank(trader);
        uint256 bought = router.swapExactInputSingle(key, _buyDirection(), 200e6, 0, block.timestamp + 60);
        uint256 usdcBefore = usdc.balanceOf(trader);
        uint256 quotedBack = router.quoteExactInputSingle(key, !_buyDirection(), bought);
        uint256 back = router.swapExactInputSingle(key, !_buyDirection(), bought, quotedBack, block.timestamp + 60);
        vm.stopPrank();
        assertEq(back, quotedBack);
        assertEq(usdc.balanceOf(trader), usdcBefore + back);
        assertEq(token.balanceOf(trader), 0, "sold everything");
        // Round trip pays 1% twice plus the pool fee — never a profit.
        assertLt(back, 200e6);
    }

    function testSlippageProtectionReverts() public {
        uint256 quoted = router.quoteExactInputSingle(key, _buyDirection(), 50e6);
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(ArcodianV4Router.TooLittleReceived.selector, quoted, quoted + 1));
        router.swapExactInputSingle(key, _buyDirection(), 50e6, quoted + 1, block.timestamp + 60);
    }

    function testExpiredDeadlineReverts() public {
        vm.warp(1000);
        vm.prank(trader);
        vm.expectRevert(ArcodianV4Router.Expired.selector);
        router.swapExactInputSingle(key, _buyDirection(), 50e6, 0, 999);
    }

    function testRouterKeepsNothing() public {
        vm.prank(trader);
        router.swapExactInputSingle(key, _buyDirection(), 75e6, 0, block.timestamp + 60);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(token.balanceOf(address(router)), 0);
    }

    function testOnlyThePoolManagerCanCallBack() public {
        vm.expectRevert(ArcodianV4Router.NotPoolManager.selector);
        router.unlockCallback("");
    }

    function testNoAllowanceNoTrade() public {
        address stranger = address(0xD00D);
        usdc.mint(stranger, 100e6);
        vm.prank(stranger);
        vm.expectRevert();
        router.swapExactInputSingle(key, _buyDirection(), 50e6, 0, block.timestamp + 60);
    }

    function testFuzzQuoteAlwaysMatchesExecution(uint64 raw) public {
        uint256 amount = bound(uint256(raw), 1e4, 5_000e6);
        uint256 quoted = router.quoteExactInputSingle(key, _buyDirection(), amount);
        vm.prank(trader);
        uint256 got = router.swapExactInputSingle(key, _buyDirection(), amount, 0, block.timestamp + 60);
        assertEq(got, quoted);
    }
}

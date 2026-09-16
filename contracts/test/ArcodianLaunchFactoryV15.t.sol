// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PumpToken} from "../src/ArcPump.sol";
import {ArcodianLaunchHookV15} from "../src/ArcodianLaunchHookV15.sol";
import {ArcodianLaunchFactoryV15} from "../src/ArcodianLaunchFactoryV15.sol";
import {ArcodianV4Router} from "../src/ArcodianV4Router.sol";

contract V15Quote {
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

/// Every fee path of the V14 hook, against a real PoolManager, for both pair
/// orderings. The property under test is always the same: whatever kind of
/// swap it is, the 1% arrives in USDC and never in the token.
contract ArcodianLaunchFactoryV15Test is Test {
    using PoolIdLibrary for PoolKey;

    PoolManager manager;
    ArcodianV4Router router;
    PoolSwapTest swapper;
    ArcodianLaunchFactoryV15 factory;
    ArcodianLaunchHookV15 hook;
    V15Quote quote;

    address payable treasury = payable(address(0xFEE));
    address creator = address(0xC0FFEE);
    address buyer = address(0xB0B);

    address constant HIGH = address(0xFFfffFFfFFfffFfFffFFfFfFfFffFfffFFFFFf01); // token is currency0
    address constant LOW = address(0x0000000000000000000000000000000000001001); // token is currency1

    uint160 constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );

    function _deploy(address quoteAt) internal {
        manager = new PoolManager(address(this));
        router = new ArcodianV4Router(manager);
        swapper = new PoolSwapTest(manager);
        deployCodeTo("ArcodianLaunchFactoryV15.t.sol:V15Quote", quoteAt);
        quote = V15Quote(quoteAt);
        address flagged = address(FLAGS | (uint160(0x5151) << 144));
        deployCodeTo(
            "ArcodianLaunchHookV15.sol:ArcodianLaunchHookV15",
            abi.encode(manager, address(this), treasury, Currency.wrap(quoteAt)),
            flagged
        );
        hook = ArcodianLaunchHookV15(flagged);
        factory = new ArcodianLaunchFactoryV15(manager, hook, Currency.wrap(quoteAt), treasury);
        hook.setFactory(address(factory));

        quote.mint(creator, 1_000_000e6);
        quote.mint(buyer, 1_000_000e6);
        vm.prank(creator);
        quote.approve(address(factory), type(uint256).max);
        vm.startPrank(buyer);
        quote.approve(address(router), type(uint256).max);
        quote.approve(address(swapper), type(uint256).max);
        vm.stopPrank();
    }

    function _launch(address quoteAt, uint256 initialBuy) internal returns (PumpToken token, PoolKey memory key, uint256 bought) {
        _deploy(quoteAt);
        vm.prank(creator);
        (address t,, uint256 got) = factory.createLaunch("Arc Bee", "ARCBEE", "", initialBuy, 0);
        token = PumpToken(t);
        bought = got;
        bool tokenIsZero = t < quoteAt;
        key = PoolKey({
            currency0: tokenIsZero ? Currency.wrap(t) : Currency.wrap(quoteAt),
            currency1: tokenIsZero ? Currency.wrap(quoteAt) : Currency.wrap(t),
            fee: 0, tickSpacing: 60, hooks: IHooks(address(hook))
        });
        vm.startPrank(buyer);
        token.approve(address(router), type(uint256).max);
        token.approve(address(swapper), type(uint256).max);
        vm.stopPrank();
    }

    function _usdc(address who) internal view returns (uint256) { return hook.claimable(who, Currency.wrap(address(quote))); }
    function _tok(address who, PumpToken token) internal view returns (uint256) { return hook.claimable(who, Currency.wrap(address(token))); }
    function _buyIsZeroForOne(PumpToken token) internal view returns (bool) { return !(address(token) < address(quote)); }

    // --- launch shape ------------------------------------------------------

    function _checkFairLaunchPrice(address quoteAt) internal {
        (PumpToken token, PoolKey memory key,) = _launch(quoteAt, 0);
        vm.prank(buyer);
        uint256 got = router.swapExactInputSingle(key, _buyIsZeroForOne(token), 1e6, 0, block.timestamp + 60);
        assertGt(got, 180_000 ether, "not starved");
        assertLt(got, 210_000 ether, "not the whole pool");
    }

    function testFairLaunchPrice_Token0() public { _checkFairLaunchPrice(HIGH); }
    function testFairLaunchPrice_Token1() public { _checkFairLaunchPrice(LOW); }

    function testNoLaunchBuyNeedsNoQuote() public {
        (PumpToken token,,) = _launch(HIGH, 0);
        assertEq(quote.balanceOf(address(manager)), 0);
        assertEq(token.balanceOf(treasury), 0, "nothing taken from supply at launch");
        assertApproxEqAbs(token.balanceOf(address(manager)), 1_000_000_000 ether, 1e9, "whole supply in the pool, bar seeding dust");
        assertEq(factory.ENGINE_VERSION(), 15);
        assertEq(factory.POOL_FEE(), 0);
    }

    // --- the four swap shapes: fee always in USDC --------------------------

    function _checkExactInBuy(address quoteAt) internal {
        (PumpToken token, PoolKey memory key,) = _launch(quoteAt, 0);
        uint256 before = quote.balanceOf(buyer);
        vm.prank(buyer);
        router.swapExactInputSingle(key, _buyIsZeroForOne(token), 100e6, 0, block.timestamp + 60);
        assertEq(before - quote.balanceOf(buyer), 100e6, "pays exactly the input");
        assertEq(_usdc(creator), 0.5e6, "creator half in USDC");
        assertEq(_usdc(treasury), 0.5e6, "treasury half in USDC");
        assertEq(_tok(creator, token) + _tok(treasury, token), 0, "nothing in token");
    }

    function testExactInBuyFeeInUsdc_Token0() public { _checkExactInBuy(HIGH); }
    function testExactInBuyFeeInUsdc_Token1() public { _checkExactInBuy(LOW); }

    function _checkExactInSell(address quoteAt) internal {
        (PumpToken token, PoolKey memory key,) = _launch(quoteAt, 0);
        bool buyDir = _buyIsZeroForOne(token);
        vm.startPrank(buyer);
        uint256 tokens = router.swapExactInputSingle(key, buyDir, 1_000e6, 0, block.timestamp + 60);
        uint256 creatorBefore = _usdc(creator);
        uint256 treasuryBefore = _usdc(treasury);
        uint256 quoted = router.quoteExactInputSingle(key, !buyDir, tokens);
        uint256 usdcBefore = quote.balanceOf(buyer);
        uint256 out = router.swapExactInputSingle(key, !buyDir, tokens, 0, block.timestamp + 60);
        vm.stopPrank();
        assertEq(out, quoted, "quote == execution");
        assertEq(quote.balanceOf(buyer) - usdcBefore, out);
        uint256 fee = (_usdc(creator) - creatorBefore) + (_usdc(treasury) - treasuryBefore);
        // Pool paid out `out + fee`, fee is 1% of that.
        assertApproxEqAbs(fee, ((out + fee) * 100) / 10_000, 1, "1% of the USDC out");
        assertGt(fee, 0);
        assertEq(_tok(creator, token) + _tok(treasury, token), 0, "sell fee is not in token");
        // No free round trip: 1% in and 1% out.
        assertLt(out, 1_000e6 * 9_802 / 10_000 + 1e6, "round trip costs ~2%");
        assertGt(out, 1_000e6 * 9_790 / 10_000, "and not more");
    }

    function testExactInSellFeeInUsdc_Token0() public { _checkExactInSell(HIGH); }
    function testExactInSellFeeInUsdc_Token1() public { _checkExactInSell(LOW); }

    function _checkExactOutBuy(address quoteAt) internal {
        (PumpToken token, PoolKey memory key,) = _launch(quoteAt, 0);
        bool buyDir = _buyIsZeroForOne(token);
        uint256 usdcBefore = quote.balanceOf(buyer);
        uint256 tokBefore = token.balanceOf(buyer);
        vm.prank(buyer);
        swapper.swap(
            key,
            SwapParams({ zeroForOne: buyDir, amountSpecified: int256(1_000_000 ether), sqrtPriceLimitX96: buyDir ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1 }),
            PoolSwapTest.TestSettings({ takeClaims: false, settleUsingBurn: false }),
            ""
        );
        assertEq(token.balanceOf(buyer) - tokBefore, 1_000_000 ether, "exact tokens out");
        uint256 paid = usdcBefore - quote.balanceOf(buyer);
        uint256 fee = _usdc(creator) + _usdc(treasury);
        assertApproxEqAbs(fee, ((paid - fee) * 100) / 10_000, 1, "1% on top of the pool input");
        assertGt(fee, 0);
        assertEq(_tok(creator, token) + _tok(treasury, token), 0);
    }

    function testExactOutBuyPaysFeeInUsdc_Token0() public { _checkExactOutBuy(HIGH); }
    function testExactOutBuyPaysFeeInUsdc_Token1() public { _checkExactOutBuy(LOW); }

    function _checkExactOutSell(address quoteAt) internal {
        (PumpToken token, PoolKey memory key,) = _launch(quoteAt, 0);
        bool buyDir = _buyIsZeroForOne(token);
        vm.startPrank(buyer);
        router.swapExactInputSingle(key, buyDir, 1_000e6, 0, block.timestamp + 60);
        uint256 feesBefore = _usdc(creator) + _usdc(treasury);
        uint256 usdcBefore = quote.balanceOf(buyer);
        swapper.swap(
            key,
            SwapParams({ zeroForOne: !buyDir, amountSpecified: int256(100e6), sqrtPriceLimitX96: !buyDir ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1 }),
            PoolSwapTest.TestSettings({ takeClaims: false, settleUsingBurn: false }),
            ""
        );
        vm.stopPrank();
        assertEq(quote.balanceOf(buyer) - usdcBefore, 100e6, "exact USDC out");
        assertEq(_usdc(creator) + _usdc(treasury) - feesBefore, 1e6, "1% of the requested USDC");
        assertEq(_tok(creator, token) + _tok(treasury, token), 0);
    }

    function testExactOutSellPaysFeeInUsdc_Token0() public { _checkExactOutSell(HIGH); }
    function testExactOutSellPaysFeeInUsdc_Token1() public { _checkExactOutSell(LOW); }

    // --- launch buy ----------------------------------------------------------

    function _checkInitialBuy(address quoteAt) internal {
        (PumpToken token,, uint256 bought) = _launch(quoteAt, 50e6);
        assertEq(token.balanceOf(creator), bought, "creator holds the launch buy");
        assertGt(bought, 9_000_000 ether, "~$50 at launch price");
        assertLt(bought, 10_100_000 ether);
        assertEq(quote.balanceOf(creator), 1_000_000e6 - 50e6, "paid exactly initialBuy");
        // Real USDC in the pool from the first block: what scanners report.
        assertEq(quote.balanceOf(address(manager)), 50e6, "USDC in the manager (pool + unclaimed fee)");
        assertEq(_usdc(creator), 0.25e6);
        assertEq(_usdc(treasury), 0.25e6);
    }

    function testInitialBuy_Token0() public { _checkInitialBuy(HIGH); }
    function testInitialBuy_Token1() public { _checkInitialBuy(LOW); }

    function testInitialBuyRespectsSlippage() public {
        _deploy(HIGH);
        vm.prank(creator);
        vm.expectRevert();
        factory.createLaunch("Arc Bee", "ARCBEE", "", 50e6, 20_000_000 ether);
    }

    // --- claims and access ---------------------------------------------------

    function testClaimPaysUsdc() public {
        (PumpToken token, PoolKey memory key,) = _launch(HIGH, 0);
        vm.prank(buyer);
        router.swapExactInputSingle(key, _buyIsZeroForOne(token), 200e6, 0, block.timestamp + 60);
        uint256 before = quote.balanceOf(creator);
        vm.prank(creator);
        hook.claim(Currency.wrap(address(quote)));
        assertEq(quote.balanceOf(creator) - before, 1e6);
        vm.prank(treasury);
        hook.claim(Currency.wrap(address(quote)));
        assertEq(quote.balanceOf(treasury), 1e6);
        vm.prank(creator);
        vm.expectRevert(ArcodianLaunchHookV15.NothingToClaim.selector);
        hook.claim(Currency.wrap(address(quote)));
    }

    function testOnlyFactoryCanOpenPoolsOnTheHook() public {
        (PumpToken token,,) = _launch(HIGH, 0);
        PoolKey memory copycat = PoolKey({
            currency0: Currency.wrap(address(token)), currency1: Currency.wrap(HIGH),
            fee: 500, tickSpacing: 10, hooks: IHooks(address(hook))
        });
        vm.expectRevert();
        manager.initialize(copycat, TickMath.getSqrtPriceAtTick(0));
    }

    function testFactoryBindsOnce() public {
        _deploy(HIGH);
        vm.expectRevert(ArcodianLaunchHookV15.FactoryAlreadySet.selector);
        hook.setFactory(address(0xBAD));
        vm.prank(address(0xBAD));
        vm.expectRevert(ArcodianLaunchHookV15.NotFactory.selector);
        hook.registerLaunch(PoolId.wrap(bytes32(uint256(1))), address(0xBAD));
    }

    function testFuzzQuoteMatchesExecution(uint96 spendRaw) public {
        uint256 spend = bound(uint256(spendRaw), 1e4, 50_000e6);
        (PumpToken token, PoolKey memory key,) = _launch(LOW, 0);
        bool buyDir = _buyIsZeroForOne(token);
        vm.startPrank(buyer);
        uint256 q = router.quoteExactInputSingle(key, buyDir, spend);
        uint256 got = router.swapExactInputSingle(key, buyDir, spend, 0, block.timestamp + 60);
        assertEq(got, q);
        uint256 q2 = router.quoteExactInputSingle(key, !buyDir, got / 2);
        uint256 out = router.swapExactInputSingle(key, !buyDir, got / 2, 0, block.timestamp + 60);
        assertEq(out, q2);
        vm.stopPrank();
    }

    // --- graduation ------------------------------------------------------------

    function _buy(PumpToken token, PoolKey memory key, uint256 usdc) internal returns (uint256) {
        vm.prank(buyer);
        return router.swapExactInputSingle(key, _buyIsZeroForOne(token), usdc, 0, block.timestamp + 60);
    }

    function testNoGraduationBelowTheLine() public {
        (PumpToken token, PoolKey memory key,) = _launch(HIGH, 0);
        _buy(token, key, 11_000e6);
        assertFalse(factory.graduatedLaunch(1));
        assertApproxEqRel(factory.quoteRaised(1), 11_000e6 * 99 / 100, 0.001e18, "raised = buys net of fee");
        assertEq(_usdc(treasury), 55e6, "only the trade fee so far");
    }

    function _checkGraduatesOnTheCrossingSwap(address quoteAt) internal {
        (PumpToken token, PoolKey memory key,) = _launch(quoteAt, 0);
        _buy(token, key, 10_000e6);
        assertFalse(factory.graduatedLaunch(1));
        uint256 tradeFeesBefore = _usdc(treasury);
        _buy(token, key, 3_000e6);
        assertTrue(factory.graduatedLaunch(1), "graduated inside the crossing buy");
        assertTrue(hook.graduated(key.toId()));
        uint256 tradeFee = 15e6;
        uint256 gradFee = _usdc(treasury) - tradeFeesBefore - tradeFee;
        // 1% of ~12,870 USDC raised.
        assertApproxEqRel(gradFee, 128.7e6, 0.01e18, "1% of raised, in USDC");
        assertEq(_tok(treasury, token), 0, "no token to the treasury");
        uint256 burned = manager.balanceOf(factory.BURN(), Currency.wrap(address(token)).toId());
        // ~72% of the supply is sold by 12.9k raised; 1% of the ~280M left.
        assertGt(burned, 2_500_000 ether, "1% of the pool's remaining tokens burned");
        assertLt(burned, 3_100_000 ether);
        // Treasury withdraws trade fees + graduation fee in one claim.
        uint256 owed = _usdc(treasury);
        vm.prank(treasury);
        hook.claim(Currency.wrap(address(quote)));
        assertEq(quote.balanceOf(treasury), owed);
        // Trading keeps working after graduation, and it only happens once.
        vm.startPrank(buyer);
        uint256 bal = token.balanceOf(buyer);
        uint256 out = router.swapExactInputSingle(key, !_buyIsZeroForOne(token), bal / 2, 0, block.timestamp + 60);
        vm.stopPrank();
        assertGt(out, 0);
        _buy(token, key, 5_000e6);
        assertEq(manager.balanceOf(factory.BURN(), Currency.wrap(address(token)).toId()), burned, "once");
    }

    function testGraduatesOnTheCrossingSwap_Token0() public { _checkGraduatesOnTheCrossingSwap(HIGH); }
    function testGraduatesOnTheCrossingSwap_Token1() public { _checkGraduatesOnTheCrossingSwap(LOW); }

    /// A fresh pool whose FIRST buy crosses the line: the manager holds no
    /// USDC yet when graduation runs mid-swap, which is why the proceeds are
    /// minted as claims instead of taken.
    function testFirstBuyCanGraduate() public {
        (PumpToken token, PoolKey memory key,) = _launch(LOW, 0);
        uint256 got = _buy(token, key, 20_000e6);
        assertGt(got, 0);
        assertTrue(factory.graduatedLaunch(1));
        vm.prank(treasury);
        hook.claim(Currency.wrap(address(quote)));
        assertGt(quote.balanceOf(treasury), 100e6 + 190e6);
    }

    function testLaunchBuyCanGraduate() public {
        (, , uint256 bought) = _launch(HIGH, 15_000e6);
        assertGt(bought, 0);
        assertTrue(factory.graduatedLaunch(1));
    }

    function testGraduationKeepsThePrice() public {
        (PumpToken token, PoolKey memory key,) = _launch(HIGH, 0);
        _buy(token, key, 11_900e6);
        uint256 before = router.quoteExactInputSingle(key, _buyIsZeroForOne(token), 1e6);
        _buy(token, key, 400e6);
        assertTrue(factory.graduatedLaunch(1), "crossed");
        uint256 afterQ = router.quoteExactInputSingle(key, _buyIsZeroForOne(token), 1e6);
        // The 400 USDC buy moved the price; graduation itself must not have
        // added more than a sliver on top of that.
        assertApproxEqRel(afterQ, before, 0.05e18);
    }

    function testOnlyHookCallsOnSwap() public {
        (, PoolKey memory key,) = _launch(HIGH, 0);
        vm.expectRevert(ArcodianLaunchFactoryV15.NotHook.selector);
        factory.onSwap(key);
    }
}

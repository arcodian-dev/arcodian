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
import {ArcodianLaunchFactoryV13} from "../src/ArcodianLaunchFactoryV13.sol";
import {ArcodianV4Router} from "../src/ArcodianV4Router.sol";

contract V13Quote {
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

/// The economics, not just the mechanics. V12 passed every mechanical test
/// and still priced a launch at zero; these assert what a buyer actually
/// receives, for BOTH pair orderings, because the launch tick's sign depends
/// on which side of the pair the token lands.
contract ArcodianLaunchFactoryV13Test is Test {
    PoolManager manager;
    ArcodianV4Router router;
    address payable treasury = payable(address(0xFEE));
    address buyer = address(0xB0B);

    function _deploy(address quoteAt, uint160 hookBits)
        internal
        returns (ArcodianLaunchFactoryV13 factory, ArcodianLaunchHook hook, V13Quote quote)
    {
        manager = new PoolManager(address(this));
        router = new ArcodianV4Router(manager);
        deployCodeTo("ArcodianLaunchFactoryV13.t.sol:V13Quote", quoteAt);
        quote = V13Quote(quoteAt);
        address flagged = address(uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG) | (hookBits << 20));
        deployCodeTo("ArcodianLaunchHook.sol:ArcodianLaunchHook", abi.encode(manager, address(this), treasury), flagged);
        hook = ArcodianLaunchHook(flagged);
        factory = new ArcodianLaunchFactoryV13(manager, hook, Currency.wrap(quoteAt), treasury);
        hook.setFactory(address(factory));
    }

    function _launchAndBuy(address quoteAt, uint160 bits, uint256 spend)
        internal
        returns (uint256 received, bool tokenIsZero, PumpToken token, PoolKey memory key)
    {
        (ArcodianLaunchFactoryV13 factory, ArcodianLaunchHook hook, V13Quote quote) = _deploy(quoteAt, bits);
        (address t,) = factory.createLaunch("Arc Bee", "ARCBEE", "");
        token = PumpToken(t);
        tokenIsZero = t < quoteAt;
        key = PoolKey({
            currency0: tokenIsZero ? Currency.wrap(t) : Currency.wrap(quoteAt),
            currency1: tokenIsZero ? Currency.wrap(quoteAt) : Currency.wrap(t),
            fee: 3000, tickSpacing: 60, hooks: IHooks(address(hook))
        });
        quote.mint(buyer, 100_000e6);
        vm.startPrank(buyer);
        quote.approve(address(router), type(uint256).max);
        received = router.swapExactInputSingle(key, !tokenIsZero, spend, 0, block.timestamp + 60);
        vm.stopPrank();
    }

    // quote parked at a very high address -> the token is currency0
    address constant HIGH = address(0xFFfffFFfFFfffFfFffFFfFfFfFffFfffFFFFFf01);
    // and at a very low one -> the token is currency1
    address constant LOW = address(0x0000000000000000000000000000000000001001);

    function testTheOrderingsReallyDiffer() public {
        (, bool zeroHigh,,) = _launchAndBuy(HIGH, 0x1111, 1e6);
        (, bool zeroLow,,) = _launchAndBuy(LOW, 0x2222, 1e6);
        assertTrue(zeroHigh, "token is currency0 when quote is high");
        assertFalse(zeroLow, "token is currency1 when quote is low");
    }

    /// The V12 bug, as a test: a small buy must take a small slice.
    function testOneUsdcBuysAboutTwoHundredThousandTokens_TokenIsCurrency0() public {
        (uint256 got,,,) = _launchAndBuy(HIGH, 0x3333, 1e6);
        assertGt(got, 180_000 ether, "not starved");
        assertLt(got, 210_000 ether, "not the whole pool");
    }

    function testOneUsdcBuysAboutTwoHundredThousandTokens_TokenIsCurrency1() public {
        (uint256 got,,,) = _launchAndBuy(LOW, 0x4444, 1e6);
        assertGt(got, 180_000 ether, "not starved");
        assertLt(got, 210_000 ether, "not the whole pool");
    }

    function testASnipeCannotTakeTheSupply() public {
        (uint256 got,,,) = _launchAndBuy(HIGH, 0x5555, 1_000e6);
        // $1,000 at a ~$5k launch FDV is a large buy; it must still leave the
        // overwhelming majority of the supply in the pool.
        assertLt(got, 200_000_000 ether, "a $1k buy takes under 20% of supply");
    }

    function testPriceClimbsAsPeopleBuy() public {
        (ArcodianLaunchFactoryV13 factory, ArcodianLaunchHook hook, V13Quote quote) = _deploy(HIGH, 0x6666);
        (address t,) = factory.createLaunch("Arc Bee", "ARCBEE", "");
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(t), currency1: Currency.wrap(HIGH),
            fee: 3000, tickSpacing: 60, hooks: IHooks(address(hook))
        });
        quote.mint(buyer, 100_000e6);
        vm.startPrank(buyer);
        quote.approve(address(router), type(uint256).max);
        uint256 first = router.swapExactInputSingle(key, false, 100e6, 0, block.timestamp + 60);
        uint256 second = router.swapExactInputSingle(key, false, 100e6, 0, block.timestamp + 60);
        vm.stopPrank();
        assertLt(second, first, "the same spend buys fewer tokens later");
    }

    function testLaunchStillCostsNoQuoteAndPaysTheFee() public {
        (ArcodianLaunchFactoryV13 factory,, V13Quote quote) = _deploy(HIGH, 0x7777);
        (address t,) = factory.createLaunch("Arc Bee", "ARCBEE", "");
        assertEq(quote.balanceOf(address(manager)), 0, "no quote capital");
        assertEq(PumpToken(t).balanceOf(treasury), 10_000_000 ether, "1% launch fee");
        assertGt(PumpToken(t).balanceOf(address(manager)), 989_000_000 ether, "supply in the pool");
    }

    function testEngineVersionIs13() public {
        (ArcodianLaunchFactoryV13 factory,,) = _deploy(HIGH, 0x8888);
        assertEq(factory.ENGINE_VERSION(), 13);
    }
}

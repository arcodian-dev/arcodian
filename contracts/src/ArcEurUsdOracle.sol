// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IArcPriceOracle} from "./ArcLend.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";

interface IUniswapV3PoolOracle {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}

interface IPythPriceUnsafe {
    struct Price {
        int64 price;
        uint64 conf;
        int32 expo;
        uint256 publishTime;
    }

    function getPriceUnsafe(bytes32 id) external view returns (Price memory);
}

/// @notice USD per EURC for ArcLend on Arc Mainnet, 18 decimals.
///
/// Arc Mainnet has no live EUR/USD push feed: Pyth's contract is deployed but
/// nobody has ever posted EUR/USD to it, and Hermes (Pyth's price service)
/// now needs an API key to fetch updates. So the price comes from the chain
/// itself — the time-weighted average of the deepest Uniswap V3 USDC/EURC
/// pool over TWAP_WINDOW — which needs no keeper and no off-chain party.
///
/// A TWAP is only as strong as its pool, so Pyth is used as a check whenever
/// it has a fresh report: if both exist and disagree by more than
/// MAX_PYTH_DEVIATION_BPS, price() reverts and the lending market keeps its
/// last good price instead of taking either. When Pyth is fresh and agrees,
/// its price is returned (tighter than a 30-minute average).
///
/// Moving a 30-minute average means holding the pool off-market for most of
/// half an hour against every arbitrageur on Arc; the market this feeds is
/// capped well below what that would cost.
contract ArcEurUsdOracle is IArcPriceOracle {
    uint256 public constant BPS = 10_000;

    IUniswapV3PoolOracle public immutable pool;
    /// True when EURC is the pool's token0.
    bool public immutable eurcIsToken0;
    uint32 public immutable twapWindow;

    IPythPriceUnsafe public immutable pyth;
    bytes32 public immutable pythPriceId;
    uint256 public immutable pythMaxAge;
    uint256 public immutable maxPythDeviationBps;

    error Invalid();
    error SourcesDisagree(uint256 twapPrice, uint256 pythPrice);

    constructor(
        IUniswapV3PoolOracle pool_,
        address usdc_,
        address eurc_,
        uint32 twapWindow_,
        IPythPriceUnsafe pyth_,
        bytes32 pythPriceId_,
        uint256 pythMaxAge_,
        uint256 maxPythDeviationBps_
    ) {
        address token0 = pool_.token0();
        address token1 = pool_.token1();
        bool usdcEurc = token0 == usdc_ && token1 == eurc_;
        bool eurcUsdc = token0 == eurc_ && token1 == usdc_;
        if (!usdcEurc && !eurcUsdc) revert Invalid();
        if (twapWindow_ < 5 minutes || twapWindow_ > 1 days) revert Invalid();
        if (maxPythDeviationBps_ == 0 || maxPythDeviationBps_ > 500) revert Invalid();
        pool = pool_;
        eurcIsToken0 = eurcUsdc;
        twapWindow = twapWindow_;
        pyth = pyth_;
        pythPriceId = pythPriceId_;
        pythMaxAge = pythMaxAge_;
        maxPythDeviationBps = maxPythDeviationBps_;
    }

    /// @notice USD per whole EURC, 18 decimals, as of this block.
    function price() external view returns (uint256 value, uint64 updatedAt) {
        value = twapPrice();
        updatedAt = uint64(block.timestamp);

        (bool fresh, uint256 pythValue) = _pythPrice();
        if (fresh) {
            uint256 delta = pythValue > value ? pythValue - value : value - pythValue;
            if (delta * BPS > value * maxPythDeviationBps) revert SourcesDisagree(value, pythValue);
            value = pythValue;
        }
    }

    /// @notice The pool's time-weighted price over twapWindow: USD per EURC, 18 dp.
    /// @dev Reverts (Uniswap's "OLD") if the pool has not recorded
    /// observations spanning the whole window — fail closed.
    function twapPrice() public view returns (uint256) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = twapWindow;
        (int56[] memory cumulatives,) = pool.observe(ago);
        int56 delta = cumulatives[1] - cumulatives[0];
        int24 tick = int24(delta / int56(uint56(twapWindow)));
        // Round toward negative infinity, as Uniswap's OracleLibrary does.
        if (delta < 0 && (delta % int56(uint56(twapWindow)) != 0)) tick--;

        uint160 sqrtPrice = TickMath.getSqrtPriceAtTick(tick);
        // token1 per token0 in raw units, as a 128-bit fixed point number.
        uint256 priceX128 = FullMath.mulDiv(sqrtPrice, sqrtPrice, 1 << 64);
        // Both tokens have 6 decimals, so raw units compare directly.
        return eurcIsToken0
            ? FullMath.mulDiv(priceX128, 1e18, 1 << 128) // USDC per EURC
            : FullMath.mulDiv(1 << 128, 1e18, priceX128); // 1 / (EURC per USDC)
    }

    function _pythPrice() internal view returns (bool fresh, uint256 value) {
        if (address(pyth) == address(0)) return (false, 0);
        try pyth.getPriceUnsafe(pythPriceId) returns (IPythPriceUnsafe.Price memory report) {
            if (report.price <= 0 || report.publishTime > block.timestamp || block.timestamp - report.publishTime > pythMaxAge) {
                return (false, 0);
            }
            int256 scale = int256(report.expo) + 18;
            if (scale < 0 || scale > 36) return (false, 0);
            return (true, uint256(uint64(report.price)) * (10 ** uint256(scale)));
        } catch {
            return (false, 0);
        }
    }
}

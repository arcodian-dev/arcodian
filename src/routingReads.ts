import { Contract, type ContractRunner } from "ethers";
import { ARC_EURC_ADDRESS, ARC_PAIR_FACTORY_ADDRESS, ARC_USDC_ERC20 } from "./config";
import { bestQuote } from "./dex";
import { FACTORY_ABI, PAIR_ABI, quoteAllTiers } from "./dexReads";
import { ROUTE_TIER, bestRoute, directRouteFrom, type DirectRoute, type MultiRoute, type Route, type V3Route } from "./routing";

export const ROUTER_ABI = [
  "function swapExactTokensForTokens(address[],uint256,uint256,uint64) returns (uint256)",
];

export const V3_FACTORY_ABI = [
  "function getPool(address,address,uint24) view returns (address)",
];

export const V3_QUOTER_ABI = [
  "function quoteExactInputSingle(address,address,uint24,uint256,uint160) returns (uint256)",
];

export const V3_POOL_ABI = [
  "function token0() view returns (address)",
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
  "function liquidity() view returns (uint128)",
];

export const V3_FEE_TIERS = [100, 500, 3000, 10000] as const;

/**
 * Tokens a route may pass through.
 *
 * USDC and EURC only, and deliberately so: they are where depth actually is.
 * Every graduated launch opens a pair against its quote currency, so a launched
 * coin is reachable from USDC or EURC, while coin-to-coin pairs are rare and
 * thin. Routing through an arbitrary third coin would mostly find worse prices
 * at more gas, and would grow the quote cost quadratically.
 */
export const ROUTE_HUBS = [ARC_USDC_ERC20, ARC_EURC_ADDRESS];

const ZERO = /^0x0+$/;

/** One hop, at the only tier ArcRouter traverses. Null if it cannot be routed. */
async function quoteHop(
  runner: ContractRunner,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  factoryAddress: string,
): Promise<{ pair: string; out: bigint } | null> {
  if (amountIn <= 0n) return null;
  try {
    const factory = new Contract(factoryAddress, FACTORY_ABI, runner);
    const pairAddress = (await factory.getPair(tokenIn, tokenOut, ROUTE_TIER)) as string;
    if (!pairAddress || ZERO.test(pairAddress)) return null;

    const pair = new Contract(pairAddress, PAIR_ABI, runner);
    const token0 = (await pair.token0()) as string;
    const out = (await pair.quote(token0.toLowerCase() === tokenIn.toLowerCase(), amountIn)) as bigint;
    return out > 0n ? { pair: pairAddress, out } : null;
  } catch {
    // An unreadable pair is simply not offered as a route.
    return null;
  }
}

/**
 * Quote every route worth considering and return both the winner and the direct
 * route it was measured against.
 *
 * The direct route is returned even when it loses, so the UI can show what the
 * multi-hop path is actually buying the user rather than asking them to trust
 * that it is better.
 */
export async function findBestRoute(
  runner: ContractRunner,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  factoryAddress: string = ARC_PAIR_FACTORY_ADDRESS,
  routeHubs: string[] = ROUTE_HUBS,
): Promise<{ chosen: Route | null; direct: DirectRoute | null }> {
  if (amountIn <= 0n || tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
    return { chosen: null, direct: null };
  }

  const directQuote = bestQuote(await quoteAllTiers(runner, tokenIn, tokenOut, amountIn, factoryAddress));
  const direct = directQuote ? directRouteFrom(directQuote, tokenIn, tokenOut) : null;

  const ends = [tokenIn.toLowerCase(), tokenOut.toLowerCase()];
  const hubs = routeHubs.filter((hub) => !ends.includes(hub.toLowerCase()));

  const multi: MultiRoute[] = [];
  for (const hub of hubs) {
    const first = await quoteHop(runner, tokenIn, hub, amountIn, factoryAddress);
    if (!first) continue;
    const second = await quoteHop(runner, hub, tokenOut, first.out, factoryAddress);
    if (!second) continue;
    multi.push({
      kind: "multi",
      out: second.out,
      path: [tokenIn, hub, tokenOut],
      pairs: [first.pair, second.pair],
      tier: ROUTE_TIER,
    });
  }

  return { chosen: bestRoute(direct, multi), direct };
}

/**
 * Discover and quote standard Uniswap V3 pools for an arbitrary ERC-20 pair.
 * The quoter is called with staticCall because its deployed implementation
 * computes the result through a revert payload, like the standard V3 flow.
 */
export async function findBestV3Route(
  runner: ContractRunner,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  factoryAddress: string,
  quoterAddress: string,
): Promise<V3Route | null> {
  if (amountIn <= 0n || tokenIn.toLowerCase() === tokenOut.toLowerCase()) return null;
  const factory = new Contract(factoryAddress, V3_FACTORY_ABI, runner);
  const quoter = new Contract(quoterAddress, V3_QUOTER_ABI, runner);
  let best: V3Route | null = null;
  for (const fee of V3_FEE_TIERS) {
    try {
      const pool = await factory.getPool(tokenIn, tokenOut, fee) as string;
      if (!pool || ZERO.test(pool)) continue;
      const out = await quoter.quoteExactInputSingle.staticCall(tokenIn, tokenOut, fee, amountIn, 0) as bigint;
      if (out > 0n && (!best || out > best.out)) {
        best = { kind: "v3", out, path: [tokenIn, tokenOut], pool, fee, venue: "Arcodian V3" };
      }
    } catch {
      // Unsupported fee tier, empty pool, or a quoter revert is not a route.
    }
  }
  return best;
}

const Q96 = 1n << 96n;
const FEE_DENOMINATOR = 1_000_000n;

/**
 * Quote a V3 pool when the venue does not publish a Quoter contract.
 * This follows the pool's current active liquidity range. The UI still runs
 * estimateGas against the real router immediately before signing, so a stale
 * or crossed-range quote cannot turn into a submitted reverting transaction.
 */
async function quoteV3Pool(
  runner: ContractRunner,
  poolAddress: string,
  tokenIn: string,
  amountIn: bigint,
  fee: number,
): Promise<bigint> {
  const pool = new Contract(poolAddress, V3_POOL_ABI, runner);
  const [token0, slot, liquidity] = await Promise.all([
    pool.token0() as Promise<string>,
    pool.slot0() as Promise<readonly [bigint, bigint, bigint, bigint, bigint, bigint, boolean]>,
    pool.liquidity() as Promise<bigint>,
  ]);
  if (liquidity <= 0n || slot[0] <= 0n) return 0n;
  const amountAfterFee = amountIn * (FEE_DENOMINATOR - BigInt(fee)) / FEE_DENOMINATOR;
  if (amountAfterFee <= 0n) return 0n;
  const zeroForOne = token0.toLowerCase() === tokenIn.toLowerCase();
  const sqrtPrice = slot[0];
  if (zeroForOne) {
    const nextSqrtPrice = liquidity * sqrtPrice * Q96 / (liquidity * Q96 + amountAfterFee * sqrtPrice);
    return nextSqrtPrice >= sqrtPrice ? 0n : liquidity * (sqrtPrice - nextSqrtPrice) / Q96;
  }
  const nextSqrtPrice = sqrtPrice + amountAfterFee * Q96 / liquidity;
  return liquidity * (nextSqrtPrice - sqrtPrice) * Q96 / (nextSqrtPrice * sqrtPrice);
}

/** Discover external standard V3 pools and quote them without a venue Quoter. */
export async function findBestExternalV3Route(
  runner: ContractRunner,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  factoryAddress: string,
  routerAddress: string,
  feeRouterAddress?: string,
): Promise<V3Route | null> {
  if (amountIn <= 0n || tokenIn.toLowerCase() === tokenOut.toLowerCase()) return null;
  const factory = new Contract(factoryAddress, V3_FACTORY_ABI, runner);
  let best: V3Route | null = null;
  for (const fee of V3_FEE_TIERS) {
    try {
      const pool = await factory.getPool(tokenIn, tokenOut, fee) as string;
      if (!pool || ZERO.test(pool)) continue;
      const protocolFee = (amountIn * 30n + 9_999n) / 10_000n;
      const netAmount = amountIn - protocolFee;
      if (netAmount <= 0n) continue;
      const out = await quoteV3Pool(runner, pool, tokenIn, netAmount, fee);
      if (out > 0n && (!best || out > best.out)) {
        best = { kind: "v3", out, path: [tokenIn, tokenOut], pool, fee, router: routerAddress, feeRouter: feeRouterAddress, venue: "External Uniswap V3" };
      }
    } catch {
      // Unsupported tier, empty pool, or a crossed/unreadable pool is skipped.
    }
  }
  return best;
}

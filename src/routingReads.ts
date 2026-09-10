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

    // quote() needs to know which side is tokenIn, which needs token0() —
    // fire both possible quote() directions alongside it (pure reserve
    // math, safe to call either way) instead of waiting for token0() to
    // resolve first. Trades one extra read-only call for one fewer
    // sequential round trip — real cost on Arc's current public RPCs is
    // ~0.3-0.8s per call (measured live 2026-09-10).
    const pair = new Contract(pairAddress, PAIR_ABI, runner);
    const [token0, outIfTrue, outIfFalse] = await Promise.all([
      pair.token0(), pair.quote(true, amountIn), pair.quote(false, amountIn),
    ]);
    const out = ((token0 as string).toLowerCase() === tokenIn.toLowerCase() ? outIfTrue : outIfFalse) as bigint;
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

  const ends = [tokenIn.toLowerCase(), tokenOut.toLowerCase()];
  const hubs = routeHubs.filter((hub) => !ends.includes(hub.toLowerCase()));

  // The direct quote and every hub's multi-hop search are independent of
  // each other (and, across hubs, of one another) — only a hub's own second
  // hop genuinely has to wait for that hub's first hop's output amount.
  const [tiers, multiResults] = await Promise.all([
    quoteAllTiers(runner, tokenIn, tokenOut, amountIn, factoryAddress),
    Promise.all(hubs.map(async (hub): Promise<MultiRoute | null> => {
      const first = await quoteHop(runner, tokenIn, hub, amountIn, factoryAddress);
      if (!first) return null;
      const second = await quoteHop(runner, hub, tokenOut, first.out, factoryAddress);
      if (!second) return null;
      return { kind: "multi", out: second.out, path: [tokenIn, hub, tokenOut], pairs: [first.pair, second.pair], tier: ROUTE_TIER };
    })),
  ]);
  const directQuote = bestQuote(tiers);
  const direct = directQuote ? directRouteFrom(directQuote, tokenIn, tokenOut) : null;
  const multi = multiResults.filter((route): route is MultiRoute => route !== null);

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
  // 4 fee tiers used to mean up to 8 sequential round trips (getPool then
  // quote, one tier at a time) before a quote appeared. Every tier's
  // getPool() is independent of the others.
  const pools = await Promise.all(
    V3_FEE_TIERS.map((fee) => (factory.getPool(tokenIn, tokenOut, fee) as Promise<string>).catch(() => null)),
  );
  const candidates = await Promise.all(V3_FEE_TIERS.map(async (fee, index): Promise<V3Route | null> => {
    const pool = pools[index];
    if (!pool || ZERO.test(pool)) return null;
    try {
      const out = await quoter.quoteExactInputSingle.staticCall(tokenIn, tokenOut, fee, amountIn, 0) as bigint;
      return out > 0n ? { kind: "v3", out, path: [tokenIn, tokenOut], pool, fee, venue: "Arcodian V3" } : null;
    } catch {
      // Empty pool or a quoter revert is not a route.
      return null;
    }
  }));
  return candidates.reduce<V3Route | null>((best, candidate) => (candidate && (!best || candidate.out > best.out) ? candidate : best), null);
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
  const protocolFee = (amountIn * 30n + 9_999n) / 10_000n;
  const netAmount = amountIn - protocolFee;
  if (netAmount <= 0n) return null;
  // Same fix as findBestV3Route above: every tier's getPool() is independent.
  const pools = await Promise.all(
    V3_FEE_TIERS.map((fee) => (factory.getPool(tokenIn, tokenOut, fee) as Promise<string>).catch(() => null)),
  );
  const candidates = await Promise.all(V3_FEE_TIERS.map(async (fee, index): Promise<V3Route | null> => {
    const pool = pools[index];
    if (!pool || ZERO.test(pool)) return null;
    try {
      const out = await quoteV3Pool(runner, pool, tokenIn, netAmount, fee);
      return out > 0n ? { kind: "v3", out, path: [tokenIn, tokenOut], pool, fee, router: routerAddress, feeRouter: feeRouterAddress, venue: "External Uniswap V3" } : null;
    } catch {
      // A crossed/unreadable pool is skipped.
      return null;
    }
  }));
  return candidates.reduce<V3Route | null>((best, candidate) => (candidate && (!best || candidate.out > best.out) ? candidate : best), null);
}

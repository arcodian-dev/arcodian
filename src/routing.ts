import type { PairQuote, Tier } from "./dex";

/**
 * Route selection across ArcPair markets.
 *
 * Two shapes exist and they are not interchangeable:
 *
 * - A direct route trades against one pair, at whichever tier is deeper. Both
 *   tiers are eligible.
 * - A multi-hop route goes through ArcRouter, which hardcodes ROUTE_TIER = 30.
 *   Tier-10 pools cannot appear in a multi-hop route, because the router would
 *   not use them — quoting one would show a price the swap cannot deliver.
 *
 * That asymmetry is the whole reason a direct route must still be quoted and
 * compared. A deep 10 bps pair routinely beats a two-hop path, and "we added
 * routing" is no excuse for handing someone a worse price than they had before.
 */

/** The only tier ArcRouter will traverse. Mirrors ArcRouter.ROUTE_TIER. */
export const ROUTE_TIER: Tier = 30;

export type DirectRoute = {
  kind: "direct";
  out: bigint;
  path: string[];
  tier: Tier;
  pair: string;
  reserveIn: bigint;
  reserveOut: bigint;
};

export type MultiRoute = {
  kind: "multi";
  out: bigint;
  path: string[];
  pairs: string[];
  tier: Tier;
};

export type V3Route = {
  kind: "v3";
  out: bigint;
  path: string[];
  pool: string;
  fee: number;
  router?: string;
  feeRouter?: string;
  venue?: string;
};

export type Route = DirectRoute | MultiRoute | V3Route;

/**
 * How much better a multi-hop route must be before it is preferred, in basis
 * points of output.
 *
 * A multi-hop swap costs more gas and touches more contracts than a direct one.
 * Switching a user onto it to win a rounding-dust improvement is a bad trade
 * dressed as a smart one, so a marginal win leaves the simpler route alone.
 */
export const MULTIHOP_MIN_GAIN_BPS = 10n;

export function hopCount(route: Route): number {
  return Math.max(1, route.path.length - 1);
}

export function directRouteFrom(quote: PairQuote, tokenIn: string, tokenOut: string): DirectRoute {
  return {
    kind: "direct",
    out: quote.out,
    path: [tokenIn, tokenOut],
    tier: quote.tier,
    pair: quote.pair,
    reserveIn: quote.reserveIn,
    reserveOut: quote.reserveOut,
  };
}

/**
 * Pick the route a user should actually take.
 *
 * Direct wins ties and near-ties. Among multi-hop candidates the largest output
 * wins, and a shorter path breaks a tie — fewer hops is less gas and less that
 * can go wrong mid-route.
 */
export function bestRoute(direct: DirectRoute | null, multi: MultiRoute[]): Route | null {
  let bestMulti: MultiRoute | null = null;
  for (const candidate of multi) {
    if (candidate.out <= 0n) continue;
    if (!bestMulti) { bestMulti = candidate; continue; }
    if (candidate.out > bestMulti.out) { bestMulti = candidate; continue; }
    if (candidate.out === bestMulti.out && hopCount(candidate) < hopCount(bestMulti)) bestMulti = candidate;
  }

  if (!direct || direct.out <= 0n) return bestMulti;
  if (!bestMulti) return direct;

  // Require a real margin, not merely "greater".
  const threshold = direct.out + (direct.out * MULTIHOP_MIN_GAIN_BPS) / 10_000n;
  return bestMulti.out > threshold ? bestMulti : direct;
}

/** How much the chosen route improves on the direct one, in basis points. */
export function routeGainBps(chosen: Route, direct: DirectRoute | null): number {
  if (!direct || direct.out <= 0n || chosen.kind === "direct") return 0;
  if (chosen.out <= direct.out) return 0;
  return Number(((chosen.out - direct.out) * 10_000n) / direct.out);
}

/** "USDC → ARCT → EURC", for showing the user where their money goes. */
export function routeLabel(path: string[], symbolFor: (address: string) => string): string {
  return path.map(symbolFor).join(" → ");
}

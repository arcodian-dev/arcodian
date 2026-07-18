import { CURVE_FEE_BPS, SWAP_FEE_BPS } from "./config";
import type { LaunchAsset } from "./shared";

/** The two stablecoins Arc quotes launches in. */
export type Currency = "USDC" | "EURC";

/** Live mid-rate from ArcFxPool, in human units (not wei). */
export type FxRate = { eurcPerUsdc: number; usdcPerEurc: number };

/** ArcFxPool.FEE_BPS — 0.10%. */
export const FX_FEE_BPS = 10;

/**
 * How a buy will actually be executed.
 * - `direct`  — the buyer already holds the asset's quote currency.
 * - `cross`   — routed USDC -> EURC -> curve buy, atomically via ArcCrossBuyRouter.
 * - `manual`  — no fast route; the existing per-currency flow runs unchanged.
 */
export type Route = "direct" | "cross" | "manual";

/** The currency a launch is quoted in. quoteKind 1 = EURC, anything else = USDC. */
export function currencyOf(asset: LaunchAsset): Currency {
  return asset.quoteKind === 1 ? "EURC" : "USDC";
}

export function convert(amount: number, from: Currency, to: Currency, rate: FxRate): number {
  if (from === to) return amount;
  return from === "USDC" ? amount * rate.eurcPerUsdc : amount * rate.usdcPerEurc;
}

/**
 * v1 routes only USDC -> EURC-quoted bonding curves. See the spec's "Scope
 * boundaries" section for why the reverse direction and graduated venues are
 * excluded. Everything excluded returns `manual`, never an error.
 */
export function routeFor(holding: Currency, asset: LaunchAsset): Route {
  if (currencyOf(asset) === holding) return "direct";
  if (holding === "USDC" && currencyOf(asset) === "EURC" && !asset.graduated) return "cross";
  return "manual";
}

/** All-in fee for a route, in basis points. Displayed to the user verbatim. */
export function totalFeeBps(route: Route, asset: LaunchAsset): number {
  const venue = asset.graduated ? SWAP_FEE_BPS : CURVE_FEE_BPS;
  return route === "cross" ? venue + FX_FEE_BPS : venue;
}

export type TrueCost = {
  route: Route;
  /** Amount of the buyer's own currency spent. */
  pays: number;
  /** Amount that reaches the venue, in the asset's quote currency. */
  quoteDelivered: number;
  feeBps: number;
};

export function trueCost(amountIn: number, holding: Currency, asset: LaunchAsset, rate: FxRate): TrueCost {
  const route = routeFor(holding, asset);
  return {
    route,
    pays: amountIn,
    quoteDelivered: convert(amountIn, holding, currencyOf(asset), rate),
    feeBps: totalFeeBps(route, asset),
  };
}

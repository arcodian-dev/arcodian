import { ARC, ARC_EURC_ADDRESS } from "./config";

/** The two fee tiers ArcPairFactory accepts, in basis points. */
export type Tier = 10 | 30;
export const TIERS: Tier[] = [10, 30];

export type PairQuote = {
  pair: string;
  tier: Tier;
  /** Output for the requested input, as returned by ArcPair.quote(). */
  out: bigint;
  reserveIn: bigint;
  reserveOut: bigint;
};

/**
 * A token couple may have a pair at each tier, with separate depth. Picking the
 * wrong one silently costs the user, so choose purely on realised output rather
 * than on the nominal fee — a deeper 30 bps pool routinely beats a thin 10 bps one.
 */
export function bestQuote(quotes: PairQuote[]): PairQuote | null {
  let best: PairQuote | null = null;
  for (const q of quotes) {
    if (q.out <= 0n) continue;
    if (!best || q.out > best.out) best = q;
  }
  return best;
}

/**
 * How far the realised output falls short of the spot-price output, in basis
 * points. This deliberately INCLUDES the swap fee: it is what the trade actually
 * costs against the pool's current price, which is the number a user needs.
 * Splitting fee from impact invites a wrong subtraction and two numbers that do
 * not add up to what they were charged.
 */
export function shortfallBps(amountIn: bigint, out: bigint, reserveIn: bigint, reserveOut: bigint): number {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0;
  const spotOut = (amountIn * reserveOut) / reserveIn;
  if (spotOut <= 0n || out >= spotOut) return 0;
  return Number(((spotOut - out) * 10_000n) / spotOut);
}

export function isTokenAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

export function shortAddress(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/**
 * True only for the Circle-issued assets whose addresses are pinned in config.
 * This is a factual claim — anyone can check it against Circle's published
 * addresses. There is deliberately no way to extend this set at runtime; see the
 * spec's "Token entry" section for why a grantable badge is refused.
 */
const CIRCLE_ASSETS = [ARC.nativeToken, ARC_EURC_ADDRESS].map((a) => a.toLowerCase());
export function isCircleAsset(address: string): boolean {
  return CIRCLE_ASSETS.includes(address.trim().toLowerCase());
}

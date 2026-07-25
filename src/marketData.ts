export const MARKET_INDEX_MAX_AGE_MS = 120_000;

/** A cached index is only authoritative while its producer is demonstrably live. */
export function isFreshMarketIndex(indexedAt: unknown, now = Date.now()): boolean {
  if (typeof indexedAt !== "string") return false;
  const timestamp = Date.parse(indexedAt);
  return Number.isFinite(timestamp) && timestamp <= now + 5_000 && now - timestamp <= MARKET_INDEX_MAX_AGE_MS;
}

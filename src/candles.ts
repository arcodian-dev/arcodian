/**
 * One candle builder for both terminals.
 *
 * The coin terminal and the trading terminal each had their own copy of the
 * same bucketing loop, and both produced the same two problems that are why
 * this chart was switched away from candlesticks in the first place:
 *
 *   1. Buckets with no trades were simply absent from the series. Most
 *      Arcodian coins trade a handful of times an hour, so a 1m chart came
 *      out as a few candles separated by holes — which reads as broken data
 *      rather than as a quiet market.
 *   2. Each bucket's open was its own first trade price, not the previous
 *      bucket's close. That opens a visible gap between every pair of
 *      candles even when the price never actually gapped.
 *
 * Filling the empty buckets and carrying the close forward as the next open
 * fixes both, and it invents nothing: a bucket with no trades really did
 * close where the last one did, and a doji is the honest way to draw it.
 * The result is a continuous candle series that stays readable on a sparse
 * market, which is what "candles, and smooth" has to mean here.
 */

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

/** One executed trade, already priced and denominated in the quote asset. */
export type CandlePoint = { timestamp: number; price: number; volume: number };

export const TIMEFRAME_SECONDS: Record<string, number> = {
  "1s": 1, "15s": 15, "1m": 60, "5m": 300, "15m": 900, "1H": 3600, "1h": 3600, "4H": 14400, "4h": 14400,
};

export function timeframeSeconds(timeframe: string | number): number {
  if (typeof timeframe === "number") return timeframe > 0 ? timeframe : 60;
  return TIMEFRAME_SECONDS[timeframe] ?? 60;
}

/**
 * @param limit how many buckets to keep, counting back from the newest.
 *   Gap-filling means this is a real time window rather than "the last N
 *   buckets that happened to have a trade", so it is also what bounds how
 *   much empty time a very quiet market can draw.
 */
export function buildCandles(points: CandlePoint[], timeframe: string | number, limit = 160): Candle[] {
  const seconds = timeframeSeconds(timeframe);
  const buckets = new Map<number, { high: number; low: number; close: number; first: number; volume: number }>();

  for (const point of points) {
    if (!Number.isFinite(point.price) || point.price <= 0) continue;
    if (!Number.isFinite(point.timestamp) || point.timestamp <= 0) continue;
    const at = Math.floor(point.timestamp / seconds) * seconds;
    const bucket = buckets.get(at);
    const volume = Number.isFinite(point.volume) && point.volume > 0 ? point.volume : 0;
    if (!bucket) {
      buckets.set(at, { high: point.price, low: point.price, close: point.price, first: point.price, volume });
    } else {
      bucket.high = Math.max(bucket.high, point.price);
      bucket.low = Math.min(bucket.low, point.price);
      bucket.close = point.price;
      bucket.volume += volume;
    }
  }
  if (!buckets.size) return [];

  const times = [...buckets.keys()].sort((a, b) => a - b);
  const start = times[0];
  const end = times[times.length - 1];
  // A market that has been quiet for days would otherwise fill millions of
  // empty buckets; start from whichever is later, the first trade or the
  // window's own left edge.
  const from = Math.max(start, end - (limit - 1) * seconds);

  const out: Candle[] = [];
  let previousClose = buckets.get(start)!.first;
  for (let at = start; at <= end; at += seconds) {
    const bucket = buckets.get(at);
    const open = previousClose;
    if (bucket) {
      const candle: Candle = {
        time: at,
        open,
        high: Math.max(bucket.high, open),
        low: Math.min(bucket.low, open),
        close: bucket.close,
        volume: bucket.volume,
      };
      previousClose = bucket.close;
      if (at >= from) out.push(candle);
    } else if (at >= from) {
      // No trades in this bucket: a doji at the last traded price. Drawing
      // it is what keeps the series continuous instead of leaving a hole.
      out.push({ time: at, open, high: open, low: open, close: open, volume: 0 });
    }
  }
  return out;
}

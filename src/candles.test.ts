import { describe, expect, it } from "vitest";
import { buildCandles, timeframeSeconds } from "./candles";

// A real unix timestamp, bucket-aligned. Not 0: the builder treats a zero
// timestamp as a missing one and skips it, which is deliberate — the index
// writes 0 when it could not resolve a block's time, and charting those at
// the epoch would drag every series back to 1970.
const T0 = 1_789_500_000;
const p = (offset: number, price: number, volume = 1) => ({ timestamp: T0 + offset, price, volume });

describe("timeframeSeconds", () => {
  it("covers every timeframe both terminals offer, in either casing", () => {
    expect(timeframeSeconds("1s")).toBe(1);
    expect(timeframeSeconds("15s")).toBe(15);
    expect(timeframeSeconds("1m")).toBe(60);
    expect(timeframeSeconds("5m")).toBe(300);
    expect(timeframeSeconds("15m")).toBe(900);
    // The trading terminal labels these 1H/4H and the coin terminal 1h/4h.
    expect(timeframeSeconds("1H")).toBe(3600);
    expect(timeframeSeconds("1h")).toBe(3600);
    expect(timeframeSeconds("4H")).toBe(14400);
    expect(timeframeSeconds("4h")).toBe(14400);
  });

  it("accepts raw seconds and falls back to a minute", () => {
    expect(timeframeSeconds(300)).toBe(300);
    expect(timeframeSeconds("nonsense")).toBe(60);
  });
});

describe("buildCandles", () => {
  it("returns nothing when there is nothing to draw", () => {
    expect(buildCandles([], "1m")).toEqual([]);
    expect(buildCandles([p(100, 0)], "1m")).toEqual([]);
  });

  it("builds real OHLC from the trades inside a bucket", () => {
    const candles = buildCandles([p(60, 10), p(70, 14), p(80, 8), p(90, 12)], "1m");
    expect(candles).toHaveLength(1);
    expect(candles[0]).toMatchObject({ open: 10, high: 14, low: 8, close: 12, volume: 4 });
  });

  it("leaves no holes when a market goes quiet", () => {
    // Trades at minute 0 and minute 5, nothing between. Without gap filling
    // this produced two candles with four minutes of empty chart between
    // them, which reads as broken rather than quiet.
    const candles = buildCandles([p(0, 10), p(300, 12)], "1m");
    expect(candles.map((c) => c.time - candles[0].time)).toEqual([0, 60, 120, 180, 240, 300]);
  });

  it("draws an untraded bucket as a doji at the last price, not as zero", () => {
    const candles = buildCandles([p(0, 10), p(300, 12)], "1m");
    const quiet = candles[2];
    expect(quiet).toMatchObject({ open: 10, high: 10, low: 10, close: 10, volume: 0 });
  });

  it("opens each candle at the previous close so the series is continuous", () => {
    const candles = buildCandles([p(0, 10), p(60, 20), p(120, 15)], "1m");
    expect(candles[1].open).toBe(candles[0].close);
    expect(candles[2].open).toBe(candles[1].close);
  });

  it("keeps the open inside the candle's own range", () => {
    // Carrying the previous close forward can put the open outside the
    // bucket's traded high/low; the wick has to stretch to include it or the
    // body renders outside its own candle.
    const candles = buildCandles([p(0, 10), p(60, 30), p(120, 5)], "1m");
    for (const candle of candles) {
      expect(candle.high).toBeGreaterThanOrEqual(Math.max(candle.open, candle.close));
      expect(candle.low).toBeLessThanOrEqual(Math.min(candle.open, candle.close));
    }
  });

  it("bounds how much empty time a very quiet market can draw", () => {
    // One trade now and one a week ago must not expand into ten thousand
    // one-minute dojis.
    const candles = buildCandles([p(0, 10), p(604800, 12)], "1m", 120);
    expect(candles.length).toBeLessThanOrEqual(120);
    expect(candles.at(-1)?.time).toBe(T0 + 604800);
  });

  it("sums volume across a bucket and reports none for a quiet one", () => {
    const candles = buildCandles([p(0, 10, 2.5), p(30, 11, 4.5), p(180, 11, 1)], "1m");
    expect(candles[0].volume).toBe(7);
    expect(candles[1].volume).toBe(0);
    expect(candles[3].volume).toBe(1);
  });

  it("ignores unusable points rather than charting them", () => {
    const candles = buildCandles([p(0, 10), p(60, Number.NaN), p(120, -3), p(180, 11)], "1m");
    expect(candles.every((c) => Number.isFinite(c.close) && c.close > 0)).toBe(true);
  });
});

describe("buildCandles — missing timestamps", () => {
  it("skips a trade the index could not date rather than charting it at the epoch", () => {
    const real = 1_789_500_000;
    const candles = buildCandles(
      [{ timestamp: 0, price: 10, volume: 1 }, { timestamp: real, price: 12, volume: 1 }],
      "1m",
    );
    expect(candles).toHaveLength(1);
    expect(candles[0].close).toBe(12);
  });
});

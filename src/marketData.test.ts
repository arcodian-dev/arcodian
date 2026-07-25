import { describe, expect, it } from "vitest";
import { isFreshMarketIndex } from "./marketData";

describe("market index freshness", () => {
  const now = Date.parse("2026-07-22T01:00:00.000Z");

  it("accepts a recently produced index", () => {
    expect(isFreshMarketIndex("2026-07-22T00:59:00.000Z", now)).toBe(true);
  });

  it("rejects a stale index so RPC fallback can run", () => {
    expect(isFreshMarketIndex("2026-07-15T07:00:13.432Z", now)).toBe(false);
  });

  it("rejects missing, invalid, and implausibly future timestamps", () => {
    expect(isFreshMarketIndex(undefined, now)).toBe(false);
    expect(isFreshMarketIndex("not-a-date", now)).toBe(false);
    expect(isFreshMarketIndex("2026-07-22T01:00:06.000Z", now)).toBe(false);
  });
});

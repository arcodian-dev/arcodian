import { describe, expect, it } from "vitest";
import { rateFromQuote } from "./fxRate";

describe("rateFromQuote", () => {
  it("builds a rate from a 6-decimal EURC-per-1-USDC quote", () => {
    const rate = rateFromQuote(920000n);
    expect(rate.eurcPerUsdc).toBeCloseTo(0.92, 6);
    expect(rate.usdcPerEurc).toBeCloseTo(1 / 0.92, 6);
  });
  it("falls back to parity when the pool is empty", () => {
    const rate = rateFromQuote(0n);
    expect(rate.eurcPerUsdc).toBe(1);
    expect(rate.usdcPerEurc).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
import { quoteAmount, quoteDecimalsOf } from "./shared";

describe("quote decimals", () => {
  it("uses the decimals the index states, over any inference", () => {
    // An explicit field must win even when the heuristics would disagree —
    // the whole point of adding it was to stop surfaces guessing differently.
    expect(quoteDecimalsOf({ quoteDecimals: 18, globalPool: true, currency: "EURC" })).toBe(18);
    expect(quoteDecimalsOf({ quoteDecimals: 6 })).toBe(6);
  });

  it("falls back to 6 for an external pool row written before the field existed", () => {
    expect(quoteDecimalsOf({ globalPool: true })).toBe(6);
  });

  it("falls back to 6 for an EURC row from the un-normalized testnet index", () => {
    expect(quoteDecimalsOf({ currency: "EURC" })).toBe(6);
  });

  it("defaults a launch curve to native USDC's 18", () => {
    expect(quoteDecimalsOf({})).toBe(18);
    expect(quoteDecimalsOf({ currency: "USDC" })).toBe(18);
  });

  it("renders a real external-pool reserve instead of zero", () => {
    // The exact numbers that were showing as 0.00 on the live Market
    // screener: Architects' pool, 123,889.997638 USDC of reserve and
    // 260,875.262116 USDC of all-time volume.
    const row = { quoteDecimals: 6, globalPool: true, currency: "USDC" };
    expect(quoteAmount("123889997638", row)).toBeCloseTo(123_889.997638, 6);
    expect(quoteAmount("260875262116", row)).toBeCloseTo(260_875.262116, 6);
  });

  it("still renders an 18-decimal curve reserve correctly", () => {
    expect(quoteAmount("1000000000000000000000", { quoteDecimals: 18 })).toBe(1000);
  });

  it("treats a missing amount as zero rather than throwing", () => {
    expect(quoteAmount(undefined, {})).toBe(0);
    expect(quoteAmount("0", { quoteDecimals: 6 })).toBe(0);
  });
});

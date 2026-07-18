import { describe, expect, it } from "vitest";
import {
  bestQuote, isCircleAsset, isTokenAddress, shortAddress, shortfallBps,
  type PairQuote,
} from "./dex";
import { ARC, ARC_EURC_ADDRESS } from "./config";

function quote(over: Partial<PairQuote> = {}): PairQuote {
  return {
    pair: "0x1111111111111111111111111111111111111111",
    tier: 30,
    out: 100n,
    reserveIn: 1000n,
    reserveOut: 1000n,
    ...over,
  };
}

describe("bestQuote", () => {
  it("returns null when no pair exists", () => {
    expect(bestQuote([])).toBeNull();
  });
  it("picks the tier with the larger output", () => {
    const stable = quote({ tier: 10, out: 120n });
    const volatile = quote({ tier: 30, out: 100n });
    expect(bestQuote([volatile, stable])?.tier).toBe(10);
  });
  it("ignores pairs that quote zero", () => {
    const empty = quote({ tier: 10, out: 0n });
    const usable = quote({ tier: 30, out: 50n });
    expect(bestQuote([empty, usable])?.tier).toBe(30);
  });
  it("returns null when every pair quotes zero", () => {
    expect(bestQuote([quote({ out: 0n })])).toBeNull();
  });
});

describe("shortfallBps", () => {
  it("is zero for an infinitely deep pool", () => {
    expect(shortfallBps(100n, 100n, 1_000_000n, 1_000_000n)).toBe(0);
  });
  it("grows as the trade takes a larger share of the pool", () => {
    const small = shortfallBps(10n, 9n, 1000n, 1000n);
    const large = shortfallBps(500n, 300n, 1000n, 1000n);
    expect(large).toBeGreaterThan(small);
  });
  it("returns 0 rather than dividing by zero on an empty pool", () => {
    expect(shortfallBps(100n, 0n, 0n, 0n)).toBe(0);
  });
});

describe("isTokenAddress", () => {
  it("accepts a checksum-shaped address", () => {
    expect(isTokenAddress("0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a")).toBe(true);
  });
  it("rejects short, empty or non-hex input", () => {
    expect(isTokenAddress("0x123")).toBe(false);
    expect(isTokenAddress("")).toBe(false);
    expect(isTokenAddress("not an address")).toBe(false);
  });
});

describe("shortAddress", () => {
  it("keeps both ends so an address stays identifiable", () => {
    expect(shortAddress("0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a")).toBe("0x89B5…D72a");
  });
});

describe("isCircleAsset", () => {
  it("recognises USDC and EURC regardless of case", () => {
    expect(isCircleAsset(ARC.nativeToken.toUpperCase())).toBe(true);
    expect(isCircleAsset(ARC_EURC_ADDRESS.toLowerCase())).toBe(true);
  });
  it("does not recognise anything else", () => {
    expect(isCircleAsset("0x1111111111111111111111111111111111111111")).toBe(false);
  });
});

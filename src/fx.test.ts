import { describe, expect, it } from "vitest";
import { convert, routeFor, totalFeeBps, trueCost, type FxRate } from "./fx";
import type { LaunchAsset } from "./shared";

const rate: FxRate = { eurcPerUsdc: 0.92, usdcPerEurc: 1 / 0.92 };

function asset(over: Partial<LaunchAsset> = {}): LaunchAsset {
  return {
    symbol: "TEST", name: "Test", type: "Meme", risk: "Curve",
    address: "0x1", curve: "0x2", image: "", progress: 0,
    reserve: 0n, virtualReserve: 0n, threshold: 0n, inventory: 0n,
    graduated: false, quoteKind: 0, currency: "USDC",
    ...over,
  } as LaunchAsset;
}

describe("convert", () => {
  it("returns the amount unchanged when currencies match", () => {
    expect(convert(10, "USDC", "USDC", rate)).toBe(10);
  });
  it("converts USDC to EURC", () => {
    expect(convert(10, "USDC", "EURC", rate)).toBeCloseTo(9.2, 6);
  });
  it("converts EURC to USDC", () => {
    expect(convert(9.2, "EURC", "USDC", rate)).toBeCloseTo(10, 6);
  });
});

describe("routeFor", () => {
  it("is direct when the holding matches the asset currency", () => {
    expect(routeFor("USDC", asset({ quoteKind: 0 }))).toBe("direct");
    expect(routeFor("EURC", asset({ quoteKind: 1 }))).toBe("direct");
  });
  it("is cross for a USDC holder buying a EURC curve coin", () => {
    expect(routeFor("USDC", asset({ quoteKind: 1 }))).toBe("cross");
  });
  it("falls back to manual for a graduated coin in the other currency", () => {
    expect(routeFor("USDC", asset({ quoteKind: 1, graduated: true }))).toBe("manual");
  });
  it("falls back to manual for a EURC holder buying a USDC coin", () => {
    expect(routeFor("EURC", asset({ quoteKind: 0 }))).toBe("manual");
  });
});

describe("totalFeeBps", () => {
  it("charges the curve fee on a direct curve buy", () => {
    expect(totalFeeBps("direct", asset())).toBe(100);
  });
  it("adds the FX fee on a cross buy", () => {
    expect(totalFeeBps("cross", asset({ quoteKind: 1 }))).toBe(110);
  });
  it("charges the DEX fee once a coin has graduated", () => {
    expect(totalFeeBps("direct", asset({ graduated: true }))).toBe(30);
  });
});

describe("trueCost", () => {
  it("reports the all-in fee for a cross buy", () => {
    const c = trueCost(10, "USDC", asset({ quoteKind: 1 }), rate);
    expect(c.route).toBe("cross");
    expect(c.feeBps).toBe(110);
    expect(c.quoteDelivered).toBeCloseTo(9.2, 6);
  });
  it("delivers the same currency on a direct buy", () => {
    const c = trueCost(10, "USDC", asset({ quoteKind: 0 }), rate);
    expect(c.quoteDelivered).toBe(10);
    expect(c.feeBps).toBe(100);
  });
});

import { describe, expect, it } from "vitest";
import { STOCKS, nextUsOpen, stockFromPath, usMarketOpen } from "./stocks";
import { isStocksRoute } from "./routeIntegrity";

describe("stocks", () => {
  it("lists ten stocks in contract order with unique Pyth feeds", () => {
    expect(STOCKS.map((s) => s.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(new Set(STOCKS.map((s) => s.feedId)).size).toBe(10);
    for (const s of STOCKS) expect(s.feedId).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("knows US regular trading hours in New York time", () => {
    expect(usMarketOpen(new Date("2026-09-17T13:29:00Z"))).toBe(false); // Thu 09:29 EDT
    expect(usMarketOpen(new Date("2026-09-17T13:30:00Z"))).toBe(true); // Thu 09:30 EDT
    expect(usMarketOpen(new Date("2026-09-17T19:59:00Z"))).toBe(true); // 15:59
    expect(usMarketOpen(new Date("2026-09-17T20:00:00Z"))).toBe(false); // 16:00
    expect(usMarketOpen(new Date("2026-09-19T15:00:00Z"))).toBe(false); // Saturday
    expect(usMarketOpen(new Date("2026-12-15T14:31:00Z"))).toBe(true); // 09:31 EST
  });

  it("finds the next US open", () => {
    expect(nextUsOpen(new Date("2026-09-18T09:30:00Z")).toISOString()).toBe("2026-09-18T13:30:00.000Z"); // Fri pre-market
    expect(nextUsOpen(new Date("2026-09-18T14:00:00Z")).toISOString()).toBe("2026-09-21T13:30:00.000Z"); // Fri open → Mon
    expect(nextUsOpen(new Date("2026-12-12T12:00:00Z")).toISOString()).toBe("2026-12-14T14:30:00.000Z"); // Sat, EST
  });

  it("reads the stock from /stocks/SYMBOL", () => {
    expect(stockFromPath("/stocks/AMZN")?.id).toBe(6);
    expect(stockFromPath("/stocks/amzn/")?.symbol).toBe("AMZN");
    expect(stockFromPath("/stocks")).toBeNull();
    expect(stockFromPath("/stocks/XYZ")).toBeNull();
  });

  it("routes /stocks", () => {
    expect(isStocksRoute("/stocks")).toBe(true);
    expect(isStocksRoute("/stocks/NVDA")).toBe(true);
    expect(isStocksRoute("/stock")).toBe(false);
  });
});

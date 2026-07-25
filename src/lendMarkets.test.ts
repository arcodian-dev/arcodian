import { describe, expect, it } from "vitest";
import { LEND_MARKETS } from "./lendMarkets";

describe("Arc Lend market registry", () => {
  it("keeps every live collateral isolated", () => {
    const live=LEND_MARKETS.filter(m=>m.status==="live");
    expect(live.length).toBeGreaterThan(0);
    expect(new Set(live.map(m=>m.marketAddress.toLowerCase())).size).toBe(live.length);
    expect(new Set(live.map(m=>m.collateralAddress.toLowerCase())).size).toBe(live.length);
  });
  it("does not list unverified ETH or BTC",()=>expect(LEND_MARKETS.some(m=>/ETH|BTC/i.test(m.collateralSymbol))).toBe(false));
  it("liquidates above max LTV",()=>{for(const m of LEND_MARKETS)expect(m.liquidationThreshold).toBeGreaterThan(m.maxLtv)});
});

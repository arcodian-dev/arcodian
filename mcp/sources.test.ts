import { describe, it, expect, vi } from "vitest";
import { makeCtx, STALE_THRESHOLD } from "./sources";

describe("sources", () => {
  it("loadIndex fetches and memoizes within TTL", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ indexedBlock: 10, agents: {} }) }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx();
    const a = await ctx.loadIndex("agents");
    const b = await ctx.loadIndex("agents");
    expect(a.indexedBlock).toBe(10);
    expect(b).toBe(a);                 // memoized, same reference
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("loadIndex throws a clear error on non-200 (fail-closed)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    const ctx = makeCtx();
    await expect(ctx.loadIndex("jobs")).rejects.toThrow(/jobs .*503/);
    vi.unstubAllGlobals();
  });

  it("STALE_THRESHOLD has a sane default", () => {
    expect(STALE_THRESHOLD).toBeGreaterThan(0);
  });
});

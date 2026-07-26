import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SellerReplayCache, createSellerReplayMiddleware } from "./x402-seller-idempotency";

describe("seller retry cache", () => {
  it("returns the same response for the exact signature and rejects mutation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arcodian-seller-"));
    const cache = new SellerReplayCache(join(dir, "cache.json"));
    const response = { paymentResponse: "receipt", status: 200, body: { ok: true } };
    await cache.store("key", "signature-a", response);
    expect(await cache.lookup("key", "signature-a")).toMatchObject(response);
    await expect(cache.lookup("key", "signature-b")).rejects.toThrow(/conflict/);
    expect((await cache.store("key", "signature-a", response)).body).toEqual({ ok: true });
  });

  it("short-circuits before settlement on duplicate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arcodian-seller-"));
    const cache = new SellerReplayCache(join(dir, "cache.json"));
    await cache.store("key", "signature-a", { paymentResponse: "receipt", status: 200, body: { ok: true } });
    const headers: Record<string, string> = {};
    const res: any = {
      setHeader: (k: string, v: string) => { headers[k] = v; },
      status: vi.fn(() => res), json: vi.fn((body) => body),
    };
    const next = vi.fn();
    await createSellerReplayMiddleware(cache)({ headers: { "x-arcodian-idempotency-key": "key", "payment-signature": "signature-a" } }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(headers["X-ARCODIAN-IDEMPOTENT-REPLAY"]).toBe("true");
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });
});

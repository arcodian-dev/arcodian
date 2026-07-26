import { describe, it, expect } from "vitest";
import { inspectSpendingPolicy } from "./payments";
import type { Ctx } from "../sources";

const ctx: Ctx = {
  loadIndex: async () => ({}),
  provider: () => { throw new Error("no rpc"); },
  tipBlock: async () => 300,
};

describe("inspect_spending_policy", () => {
  it("reports policy fields + merchant allowance via injected reader", async () => {
    const reader = async () => ({
      policy: { perPayment: 1000000n, dailyLimit: 5000000n, spentToday: 250000n, validUntil: 1799999999, enabled: true },
      merchantAllowed: true,
    });
    const r = await inspectSpendingPolicy({ vault: "0xv", agentId: "851849", merchant: "0xm" }, ctx, reader);
    expect(r.enabled).toBe(true);
    expect(r.merchantAllowed).toBe(true);
    expect(r.perPayment).toBe("1000000");
    expect(r.evidence.source).toBe("rpc");
  });
});

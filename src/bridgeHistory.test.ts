import { beforeEach, describe, expect, it } from "vitest";
import { attestationCountdown, bridgeAttention, isMainnetBridgeChainId, loadBridgeHistory, recordBridgeHistory, savePendingClaim } from "./bridgeRecovery";

const account = "0x000000000000000000000000000000000000dEaD";
const burnHash = `0x${"ab".repeat(32)}`;

describe("bridge history", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key), clear: () => values.clear() } });
  });
  it("records a pending burn without duplicating its hash", () => {
    savePendingClaim(account, { burnHash, fromChainId: 1, toChainId: 2, amount: "1000000", createdAt: 100 });
    savePendingClaim(account, { burnHash, fromChainId: 1, toChainId: 2, amount: "1000000", createdAt: 100 });
    expect(loadBridgeHistory(account)).toHaveLength(1);
  });
  it("preserves a completed transfer in history", () => {
    recordBridgeHistory(account, { burnHash, fromChainId: 1, toChainId: 2, status: "completed", mintHash: `0x${"cd".repeat(32)}`, createdAt: 100 });
    expect(loadBridgeHistory(account)[0].status).toBe("completed");
  });
  it("flags delayed and stuck transfers by stage age", () => {
    const base = { burnHash, fromChainId: 1, toChainId: 2, status: "pending" as const, createdAt: 1, updatedAt: 1 };
    expect(bridgeAttention(base, 21 * 60 * 1000).level).toBe("delayed");
    expect(bridgeAttention(base, 61 * 60 * 1000).level).toBe("attention");
  });
  it("separates mainnet bridge history from legacy testnet records", () => {
    expect([1, 10, 42161, 8453, 5042].every(isMainnetBridgeChainId)).toBe(true);
    expect([11155111, 11155420, 421614, 84532, 5042002].some(isMainnetBridgeChainId)).toBe(false);
  });
  it("counts down by source chain and becomes delayed without blocking readiness polling", () => {
    const createdAt = 1_000;
    expect(attestationCountdown({ burnHash, fromChainId: 8453, toChainId: 5042, createdAt }, createdAt).remainingSeconds).toBe(20 * 60);
    expect(attestationCountdown({ burnHash, fromChainId: 1, toChainId: 5042, createdAt }, createdAt).remainingSeconds).toBe(25 * 60);
    expect(attestationCountdown({ burnHash, fromChainId: 8453, toChainId: 5042, createdAt }, createdAt + 21 * 60 * 1000).delayed).toBe(true);
  });
});

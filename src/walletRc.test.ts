import { describe, expect, it } from "vitest";
import { mergeWalletNotices, parseWalletDeepLink, shouldAutoLock, systemAlertsToWalletNotices } from "./walletRc";

describe("Android wallet RC controls", () => {
  it("locks only after the configured inactivity window", () => {
    expect(shouldAutoLock(1_000, 120_999, 120_000)).toBe(false);
    expect(shouldAutoLock(1_000, 121_000, 120_000)).toBe(true);
  });
  it("deduplicates notices and keeps newest first", () => {
    const old = { id: "a", kind: "security" as const, title: "A", detail: "", createdAt: 1, read: false };
    const fresh = { id: "b", kind: "payment" as const, title: "B", detail: "", createdAt: 2, read: false };
    expect(mergeWalletNotices([old], [fresh, old]).map((row) => row.id)).toEqual(["b", "a"]);
  });
  it("accepts bounded Arcodian deep links and rejects web links", () => {
    expect(parseWalletDeepLink("arcodian://bridge?burn=0xabc")).toEqual({ view: "bridge", burn: "0xabc" });
    expect(parseWalletDeepLink("https://evil.example/pay")).toBeNull();
  });
  it("maps global alerts and only account-scoped policy alerts for the matching wallet", () => {
    const alerts = [
      { id:"oracle", source:"lend" as const, severity:"critical" as const, title:"Oracle stale", detail:"", createdAt:2 },
      { id:"policy", source:"agentpay" as const, severity:"warning" as const, title:"Policy expiring", detail:"", createdAt:1, accounts:["0xabc"] },
    ];
    expect(systemAlertsToWalletNotices(alerts,"0xabc").map((row)=>row.id)).toEqual(["system:oracle","system:policy"]);
    expect(systemAlertsToWalletNotices(alerts,"0xdef").map((row)=>row.id)).toEqual(["system:oracle"]);
  });
});

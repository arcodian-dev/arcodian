import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const report = JSON.parse(readFileSync(new URL("../public/developers/mainnet-readiness.json", import.meta.url), "utf8"));

describe("mainnet readiness report", () => {
  it("fails closed while required production gates remain open", () => {
    expect(report.decision).toBe("NO_GO");
    expect(report.currentNetwork.chainId).toBe(5042002);
    expect(report.gates.filter((gate: { status: string }) => gate.status === "blocked").length).toBeGreaterThanOrEqual(2);
  });

  it("records governance and independent-audit blockers explicitly", () => {
    const blocked = new Set(report.gates.filter((gate: { status: string }) => gate.status === "blocked").map((gate: { id: string }) => gate.id));
    expect(blocked).toContain("independent-audit");
    expect(report.gates.find((gate: { id: string }) => gate.id === "source-verification")?.status).toBe("passed");
  });
});

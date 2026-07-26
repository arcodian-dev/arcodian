import { describe, it, expect } from "vitest";
import { findAgents, inspectAgent } from "./agents";
import type { Ctx } from "../sources";

const agentsIdx = {
  indexedBlock: 100,
  agents: {
    "1": { agentId: "1", owner: "0xowner1", wallet: "0xw1" },
    "2": { agentId: "2", owner: "0xowner2", wallet: "0xw2" },
  },
};
const repIdx = {
  indexedBlock: 100,
  agents: [
    { agentId: "1", score: 80, confidence: 0.9, dimensions: { completionRate: 1 }, flags: [], validation: { independentCount: 2 }, feedback: [] },
    { agentId: "2", score: 10, confidence: 0.2, dimensions: { completionRate: 0.5 }, flags: [], validation: { independentCount: 0 }, feedback: [] },
  ],
};
const ctx = (over: Partial<Ctx> = {}): Ctx => ({
  loadIndex: async (n: string) => (n === "agents" ? agentsIdx : repIdx),
  provider: () => { throw new Error("no rpc in this test"); },
  tipBlock: async () => 110,
  ...over,
});

describe("find_agents", () => {
  it("filters by minReputation and sorts by score desc", async () => {
    const r = await findAgents({ minReputation: 50 }, ctx());
    expect(r.agents.map((a: any) => a.agentId)).toEqual(["1"]);
    expect(r.agents[0].score).toBe(80);
    expect(r.evidence.source).toBe("index");
  });

  it("requireValidation drops agents with no independent validation", async () => {
    const r = await findAgents({ requireValidation: true }, ctx());
    expect(r.agents.map((a: any) => a.agentId)).toEqual(["1"]);
  });

  it("returns evidence with staleness when index lags", async () => {
    const r = await findAgents({}, ctx({ tipBlock: async () => 1000 }));
    expect(r.evidence.stale).toBe(true);
  });
});

describe("inspect_agent", () => {
  it("merges identity + reputation summary", async () => {
    const identityCtx = ctx({
      provider: () => ({
        // minimal ethers-like stub used via Contract in impl -> we bypass by injecting resolver
      }) as any,
    });
    // inspectAgent reads identity via ctx.provider(); we assert reputation join here by stubbing resolveIdentity
    const r = await inspectAgent({ agentId: "1" }, identityCtx, async () => ({ owner: "0xowner1", wallet: "0xw1", tokenURI: "ipfs://x", integrity: "unchecked" }));
    expect(r.agentId).toBe("1");
    expect(r.reputation?.score).toBe(80);
    expect(r.identity.owner).toBe("0xowner1");
  });
});

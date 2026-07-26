import { describe, it, expect } from "vitest";
import { Interface, parseEther } from "ethers";
import { buildCreateJob, buildLeaveFeedback } from "./builders";
import { AGENT_JOBS_ADDRESS, AGENT_JOBS_ABI, REPUTATION_REGISTRY_ADDRESS, REPUTATION_REGISTRY_ABI } from "./_config";
import type { Ctx } from "../sources";

const ctx: Ctx = { loadIndex: async () => ({}), provider: () => ({}) as any, tipBlock: async () => 400 };
// simulator that always succeeds
const okSim = async () => ({ ok: true, gasEstimate: "120000", revertReason: null });

describe("build_create_job", () => {
  it("encodes createJob calldata that decodes back to the inputs", async () => {
    const client = "0xcccccccccccccccccccccccccccccccccccccccc";
    const provider = "0x1111111111111111111111111111111111111111";
    const evaluator = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const r = await buildCreateJob(
      { client, provider, evaluator, budget: "0.4", expiry: 1799999999, providerAgentId: "851849" },
      ctx, okSim,
    );
    expect(r.to.toLowerCase()).toBe(AGENT_JOBS_ADDRESS.toLowerCase());
    expect(r.value).toBe(parseEther("0.4").toString());
    const decoded = new Interface(AGENT_JOBS_ABI).decodeFunctionData("createJob", r.data);
    expect(decoded[0].toLowerCase()).toBe(provider);  // provider
    expect(decoded[4].toString()).toBe("851849");   // providerAgentId
    expect(r.simulation.ok).toBe(true);
  });
});

describe("build_leave_feedback", () => {
  it("encodes giveFeedback with score int128 + decimals 0", async () => {
    const r = await buildLeaveFeedback({ agentId: "851849", score: 90, jobId: "4" }, ctx, okSim);
    const d = new Interface(REPUTATION_REGISTRY_ABI).decodeFunctionData("giveFeedback", r.data);
    expect(d[0].toString()).toBe("851849"); // agentId
    expect(d[1].toString()).toBe("90");     // score int128
    expect(d[2]).toBe(0n);                   // decimals
    expect(r.to.toLowerCase()).toBe(REPUTATION_REGISTRY_ADDRESS.toLowerCase());
  });
});

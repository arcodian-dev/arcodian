import { describe, it, expect } from "vitest";
import { listJobs, inspectJob } from "./jobs";
import type { Ctx } from "../sources";

const jobsIdx = {
  indexedBlock: 200,
  jobs: [
    { jobId: "4", client: "0xc", provider: "0xp", evaluator: "0xe", status: "Completed", providerAgentId: "851849", budget: "400000000000000000" },
    { jobId: "3", client: "0xc", provider: "0xp", evaluator: "0xe", status: "Expired", providerAgentId: "0", budget: "300000000000000000" },
  ],
};
const ctx = (over: Partial<Ctx> = {}): Ctx => ({
  loadIndex: async () => jobsIdx,
  provider: () => { throw new Error("no rpc"); },
  tipBlock: async () => 210,
  ...over,
});

describe("list_jobs", () => {
  it("filters by status", async () => {
    const r = await listJobs({ status: "Completed" }, ctx());
    expect(r.jobs.map((j: any) => j.jobId)).toEqual(["4"]);
  });
  it("filters by providerAgentId", async () => {
    const r = await listJobs({ providerAgentId: "851849" }, ctx());
    expect(r.jobs).toHaveLength(1);
    expect(r.evidence.source).toBe("index");
  });
});

describe("inspect_job", () => {
  it("reads the on-chain struct via injected reader (rpc-authoritative)", async () => {
    const reader = async (_id: string) => ({
      client: "0xc", provider: "0xp", evaluator: "0xe", budget: 400000000000000000n,
      expiry: 1784993879, status: 3, descHash: "0xd", deliverableHash: "0x46", providerAgentId: 851849n,
    });
    const r = await inspectJob({ jobId: "4" }, ctx(), reader);
    expect(r.status).toBe("Completed");
    expect(r.providerAgentId).toBe("851849");
    expect(r.evidence.source).toBe("rpc");
  });
});

import { describe, it, expect } from "vitest";
import {
  scoreProvider, classifyFeedback, classifyValidation, meetsPolicy, WEIGHTS, K,
} from "./reputation";
import type { RepJob, Resolvers, RegFeedback, RegValidation } from "./reputation";

const noResolvers: Resolvers = { ownerOfAgent: {}, agentIdOfWallet: {} };
function job(p: Partial<RepJob>): RepJob {
  return {
    jobId: "1", client: "0xC", provider: "0xP", evaluator: "0xE", providerAgentId: "0",
    status: "Completed", budget: "1000000000000000000", createdAt: 1000, expiry: 2000, submittedAt: 1200,
    deliverableHash: "0xd1", evidenceHash: "0xe1", ...p,
  };
}

describe("scoreProvider objective tier", () => {
  it("all completed, submitted early -> high score, high confidence at scale", () => {
    const jobs = Array.from({ length: 10 }, (_, i) => job({ jobId: String(i + 1), client: "0xC" + i, evaluator: "0xE" + i, deliverableHash: "0xd" + i, evidenceHash: "0xe" + i }));
    const r = scoreProvider("0xP", jobs, noResolvers);
    expect(r.counts.completed).toBe(10);
    expect(r.confidence).toBeCloseTo(10 / (10 + K), 5);
    expect(r.score).toBeGreaterThan(70);
    expect(r.flags).not.toContain("self_review");
  });
  it("a single completed job is confidence-shrunk (cannot show 100)", () => {
    const r = scoreProvider("0xP", [job({})], noResolvers);
    expect(r.confidence).toBeCloseTo(1 / (1 + K), 5); // 0.25
    expect(r.score).toBeLessThanOrEqual(25);
  });
  it("rejections lower reliability; expiries lower completion", () => {
    const jobs = [
      job({ jobId: "1", deliverableHash: "0xd1", evidenceHash: "0xe1" }),
      job({ jobId: "2", status: "Rejected", deliverableHash: "0xd2", evidenceHash: "0xe2" }),
      job({ jobId: "3", status: "Expired", submittedAt: undefined, deliverableHash: "0xd3", evidenceHash: "0xe3" }),
    ];
    const r = scoreProvider("0xP", jobs, noResolvers);
    expect(r.counts.completed).toBe(1); expect(r.counts.rejected).toBe(1); expect(r.counts.expired).toBe(1);
    expect(r.dimensions.completionRate).toBeCloseTo(1 / 3, 5);
    expect(r.dimensions.disputeRate).toBeCloseTo(1 / 2, 5); // rejected/(completed+rejected)
  });
  it("weights sum to 1", () => { expect(WEIGHTS.completion + WEIGHTS.reliability + WEIGHTS.timeliness).toBeCloseTo(1, 9); });
});

describe("risk flags", () => {
  const base = (p: Partial<RepJob>): RepJob => job({ providerAgentId: "7", submittedAt: 1100, ...p });
  it("self-review by wallet is excluded", () => {
    const r = scoreProvider("0xP", [base({}), base({ jobId: "2", evaluator: "0xP" })], noResolvers);
    expect(r.flags).toContain("self_review"); expect(r.excludedJobIds).toContain("2");
  });
  it("self-review by shared owner is excluded", () => {
    const res: Resolvers = { ownerOfAgent: { "7": "0xowner", "9": "0xowner" }, agentIdOfWallet: { "0xe": "9" } };
    const r = scoreProvider("0xP", [base({ jobId: "3", evaluator: "0xE" })], res);
    expect(r.flags).toContain("self_review"); expect(r.excludedJobIds).toContain("3");
  });
  it("duplicate evidence is excluded", () => {
    const r = scoreProvider("0xP", [base({ jobId: "1", deliverableHash: "0xSAME" }), base({ jobId: "2", client: "0xC2", evaluator: "0xE2", deliverableHash: "0xSAME" })], noResolvers);
    expect(r.flags).toContain("duplicate_evidence"); expect(r.excludedJobIds).toContain("2");
  });
  it("concentration reduces confidence", () => {
    const jobs = Array.from({ length: 5 }, (_, i) => base({ jobId: String(i + 1), client: "0xSOLE", evaluator: "0xE" + i, deliverableHash: "0xd" + i, evidenceHash: "0xe" + i }));
    const r = scoreProvider("0xP", jobs, noResolvers);
    expect(r.flags).toContain("counterparty_concentration");
    expect(r.confidence).toBeLessThan(5 / (5 + K)); // penalized below the raw shrinkage
  });
});

describe("feedback + validation classification", () => {
  const jobs: RepJob[] = [job({ jobId: "1", providerAgentId: "7", deliverableHash: "0xd" })];
  it("feedback from the job evaluator is evidence_backed; a stranger is unverified", () => {
    const fb: RegFeedback[] = [
      { agentId: "7", client: "0xE", score: 90, tag1: "", tag2: "", endpoint: "", filehash: "0x0", index: 1 },
      { agentId: "7", client: "0xSTRANGER", score: 10, tag1: "", tag2: "", endpoint: "", filehash: "0x0", index: 1 },
    ];
    const c = classifyFeedback("7", fb, jobs);
    expect(c.find(x => x.client === "0xE")!.evidenceBacked).toBe(true);
    expect(c.find(x => x.client === "0xSTRANGER")!.evidenceBacked).toBe(false);
  });
  it("validation by a job participant is non-independent", () => {
    const v: RegValidation[] = [
      { agentId: "7", validator: "0xP", dataHash: "0xd", response: 100 },
      { agentId: "7", validator: "0xIND", dataHash: "0xd", response: 80 },
    ];
    const c = classifyValidation("7", v, jobs);
    expect(c.find(x => x.validator === "0xP")!.independent).toBe(false);
    expect(c.find(x => x.validator === "0xIND")!.independent).toBe(true);
  });
});

describe("meetsPolicy preflight", () => {
  const rep = scoreProvider("0xP", Array.from({ length: 10 }, (_, i) => job({ jobId: String(i + 1), status: i === 0 ? "Rejected" : "Completed", client: "0xC" + i, evaluator: "0xE" + i, deliverableHash: "0xd" + i, evidenceHash: "0xe" + i })), noResolvers);
  it("passes when thresholds met", () => {
    expect(meetsPolicy(rep, { minCompletedJobs: 5, maxDisputeRate: 0.2 }).ok).toBe(true);
  });
  it("fails with reasons when below score / above dispute", () => {
    const res = meetsPolicy(rep, { minScore: 99, minCompletedJobs: 5, maxDisputeRate: 0.05 });
    expect(res.ok).toBe(false); expect(res.reasons.length).toBeGreaterThan(0);
  });
});

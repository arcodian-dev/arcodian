import { Contract, formatEther } from "ethers";
import type { Ctx } from "../sources.ts";
import { indexEvidence, rpcEvidence, txLink, addrLink } from "../evidence.ts";
import { AGENT_JOBS_ADDRESS, AGENT_JOBS_ABI } from "./_config.ts";

const STATUS = ["None", "Funded", "Submitted", "Completed", "Rejected", "Expired"];
const lc = (x: any) => String(x || "").toLowerCase();

export async function listJobs(
  input: { status?: string; client?: string; provider?: string; providerAgentId?: string; limit?: number },
  ctx: Ctx,
) {
  const [feed, tip] = await Promise.all([ctx.loadIndex("jobs"), ctx.tipBlock()]);
  let jobs = feed.jobs || [];
  if (input.status) jobs = jobs.filter((j: any) => j.status === input.status);
  if (input.client) jobs = jobs.filter((j: any) => lc(j.client) === lc(input.client));
  if (input.provider) jobs = jobs.filter((j: any) => lc(j.provider) === lc(input.provider));
  if (input.providerAgentId) jobs = jobs.filter((j: any) => String(j.providerAgentId) === String(input.providerAgentId));
  if (input.limit) jobs = jobs.slice(0, input.limit);
  return {
    jobs: jobs.map((j: any) => ({ jobId: j.jobId, status: j.status, client: j.client, provider: j.provider, evaluator: j.evaluator, providerAgentId: j.providerAgentId, budget: j.budget, links: { explorer: `${addrLink(AGENT_JOBS_ADDRESS)}` } })),
    evidence: indexEvidence(tip, feed.indexedBlock ?? tip, AGENT_JOBS_ADDRESS),
  };
}

export type JobReader = (jobId: string) => Promise<any>;
export async function inspectJob(input: { jobId: string }, ctx: Ctx, reader?: JobReader) {
  const tip = await ctx.tipBlock();
  const read = reader ?? (async (id: string) => new Contract(AGENT_JOBS_ADDRESS, AGENT_JOBS_ABI, ctx.provider()).jobs(id));
  const j = await read(input.jobId);
  // merge feed extras (evidenceHash, settleTx) when present
  const feed = await ctx.loadIndex("jobs").catch(() => ({ jobs: [] }));
  const extra = (feed.jobs || []).find((f: any) => String(f.jobId) === String(input.jobId)) || {};
  return {
    jobId: String(input.jobId),
    client: j.client, provider: j.provider, evaluator: j.evaluator,
    budget: formatEther(j.budget), expiry: Number(j.expiry),
    status: STATUS[Number(j.status)] || "Unknown",
    descHash: j.descHash, deliverableHash: j.deliverableHash,
    providerAgentId: j.providerAgentId.toString(),
    evidenceHash: extra.evidenceHash ?? null,
    settleTx: extra.settleTx ?? null,
    evidence: rpcEvidence(tip, AGENT_JOBS_ADDRESS, { explorer: addrLink(AGENT_JOBS_ADDRESS), ...(extra.settleTx ? { settlement: txLink(extra.settleTx) } : {}) }),
  };
}

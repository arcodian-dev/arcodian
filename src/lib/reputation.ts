// Phase C — pure reputation scoring. No network; the indexer and vitest both drive this.
// Every number is reproducible from indexed on-chain events (ArcAgentJobs + the two
// ERC-8004 registries). See public/reputation-methodology.md.

export type RepStatus = "Completed" | "Rejected" | "Expired" | "Funded" | "Submitted" | "None";
export type RepJob = {
  jobId: string; client: string; provider: string; evaluator: string; providerAgentId: string;
  status: RepStatus; budget: string; createdAt?: number; expiry: number; submittedAt?: number;
  deliverableHash: string; evidenceHash?: string;
};
export type Resolvers = { ownerOfAgent: Record<string, string>; agentIdOfWallet: Record<string, string> };
export type RepFlag =
  | "self_review" | "reciprocal_ring" | "duplicate_evidence"
  | "reputation_burst" | "counterparty_concentration" | "non_independent_validator";

export const WEIGHTS = { completion: 0.5, reliability: 0.3, timeliness: 0.2 };
export const K = 3;
export const BURST = { minJobs: 5, windowSec: 3600, maxClients: 2 };
export const CONCENTRATION = { threshold: 0.6, penalty: 0.8 };

const lc = (x: string) => (x || "").toLowerCase();

export type RepResult = {
  provider: string; score: number; confidence: number;
  counts: { completed: number; rejected: number; expired: number; total: number };
  dimensions: { completionRate: number; disputeRate: number; reliability: number; timeliness: number };
  context: { settledVolume: string; distinctClients: number; distinctEvaluators: number };
  flags: RepFlag[]; eligibleJobIds: string[]; excludedJobIds: string[];
};

// Owner-aware self-review: wallet match OR shared identity owner.
function isSelfReview(j: RepJob, r: Resolvers): boolean {
  const p = lc(j.provider);
  if (lc(j.client) === p || lc(j.evaluator) === p) return true;
  const provOwner = lc(r.ownerOfAgent[j.providerAgentId] || "");
  if (!provOwner) return false;
  for (const w of [j.client, j.evaluator]) {
    const aid = r.agentIdOfWallet[lc(w)];
    if (aid && lc(r.ownerOfAgent[aid] || "") === provOwner) return true;
  }
  return false;
}

export function scoreProvider(provider: string, jobs: RepJob[], r: Resolvers): RepResult {
  // Oldest-first so duplicate-evidence detection keeps the FIRST use and flags later reuse (deterministic).
  const terminal = jobs
    .filter(j => j.status === "Completed" || j.status === "Rejected" || j.status === "Expired")
    .sort((a, b) => (Number(a.jobId) - Number(b.jobId)) || a.jobId.localeCompare(b.jobId));
  const flags = new Set<RepFlag>();
  const excluded = new Set<string>();

  // self-review exclusion
  for (const j of terminal) { if (isSelfReview(j, r)) { flags.add("self_review"); excluded.add(j.jobId); } }

  // duplicate-evidence exclusion (same non-zero deliverable/evidence hash reused)
  const seen = new Map<string, string>();
  for (const j of terminal) {
    for (const h of [j.deliverableHash, j.evidenceHash]) {
      if (!h || /^0x0+$/.test(h)) continue;
      const key = lc(h);
      if (seen.has(key) && seen.get(key) !== j.jobId) { flags.add("duplicate_evidence"); excluded.add(j.jobId); }
      else seen.set(key, j.jobId);
    }
  }

  const eligible = terminal.filter(j => !excluded.has(j.jobId));
  const completed = eligible.filter(j => j.status === "Completed");
  const rejected = eligible.filter(j => j.status === "Rejected");
  const expired = eligible.filter(j => j.status === "Expired");
  const n = eligible.length;

  const completionRate = n ? completed.length / n : 0;
  const delivered = completed.length + rejected.length;
  const disputeRate = delivered ? rejected.length / delivered : 0;
  const reliability = 1 - disputeRate;

  // timeliness: earlier submit relative to the funding->expiry window
  const tSamples = [...completed, ...rejected]
    .filter(j => j.submittedAt != null && j.createdAt != null && j.expiry > (j.createdAt as number))
    .map(j => Math.max(0, Math.min(1, (j.expiry - (j.submittedAt as number)) / (j.expiry - (j.createdAt as number)))));
  const timeliness = tSamples.length ? tSamples.reduce((a, b) => a + b, 0) / tSamples.length : 0;

  let confidence = n / (n + K);

  // counterparty concentration -> confidence penalty
  const byClient = new Map<string, number>(); const byEval = new Map<string, number>();
  for (const j of completed) {
    byClient.set(lc(j.client), (byClient.get(lc(j.client)) || 0) + 1);
    byEval.set(lc(j.evaluator), (byEval.get(lc(j.evaluator)) || 0) + 1);
  }
  const maxShare = (m: Map<string, number>) => completed.length ? Math.max(0, ...[...m.values()]) / completed.length : 0;
  if (completed.length >= 3 && (maxShare(byClient) > CONCENTRATION.threshold || maxShare(byEval) > CONCENTRATION.threshold)) {
    flags.add("counterparty_concentration"); confidence *= CONCENTRATION.penalty;
  }

  // reputation burst: >=minJobs completions within windowSec drawn from <maxClients distinct clients
  const times = completed.filter(j => j.submittedAt != null).map(j => j.submittedAt as number).sort((a, b) => a - b);
  for (let i = 0; i + BURST.minJobs - 1 < times.length; i++) {
    if (times[i + BURST.minJobs - 1] - times[i] <= BURST.windowSec) {
      const window = completed.filter(j => j.submittedAt != null && (j.submittedAt as number) >= times[i] && (j.submittedAt as number) <= times[i] + BURST.windowSec);
      const clients = new Set(window.map(j => lc(j.client)));
      if (clients.size < BURST.maxClients) { flags.add("reputation_burst"); break; }
    }
  }

  const score = Math.round(100 * confidence * (WEIGHTS.completion * completionRate + WEIGHTS.reliability * reliability + WEIGHTS.timeliness * timeliness));
  const settledVolume = completed.reduce((a, j) => a + BigInt(j.budget), 0n).toString();

  return {
    provider, score, confidence,
    counts: { completed: completed.length, rejected: rejected.length, expired: expired.length, total: terminal.length },
    dimensions: { completionRate, disputeRate, reliability, timeliness },
    context: { settledVolume, distinctClients: byClient.size, distinctEvaluators: byEval.size },
    flags: [...flags], eligibleJobIds: eligible.map(j => j.jobId), excludedJobIds: [...excluded],
  };
}

// --- Tier 2 (subjective feedback) + Tier 3 (independent validation) classification ---

export type RegFeedback = { agentId: string; client: string; score: number; tag1: string; tag2: string; endpoint: string; filehash: string; index: number };
export type RegValidation = { agentId: string; validator: string; dataHash: string; response: number };
export type ClassifiedFeedback = RegFeedback & { evidenceBacked: boolean; jobId?: string };
export type ClassifiedValidation = RegValidation & { independent: boolean; jobId?: string };
export type Policy = { minScore?: number; minCompletedJobs?: number; maxDisputeRate?: number };

// evidence_backed: rater is the client or evaluator of a real Completed job for this agent.
export function classifyFeedback(agentId: string, feedback: RegFeedback[], jobs: RepJob[]): ClassifiedFeedback[] {
  const completed = jobs.filter(j => j.status === "Completed" && j.providerAgentId === agentId);
  return feedback.map(f => {
    const j = completed.find(j => lc(j.client) === lc(f.client) || lc(j.evaluator) === lc(f.client));
    return { ...f, evidenceBacked: Boolean(j), jobId: j?.jobId };
  });
}

// independent: validator is not the job's client/provider/evaluator.
export function classifyValidation(agentId: string, validations: RegValidation[], jobs: RepJob[]): ClassifiedValidation[] {
  const forAgent = jobs.filter(j => j.providerAgentId === agentId);
  return validations.map(v => {
    const j = forAgent.find(j => lc(j.deliverableHash) === lc(v.dataHash));
    const parties = j ? new Set([lc(j.client), lc(j.provider), lc(j.evaluator)]) : new Set<string>();
    return { ...v, independent: !parties.has(lc(v.validator)), jobId: j?.jobId };
  });
}

export function meetsPolicy(rep: RepResult, policy: Policy): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (policy.minScore != null && rep.score < policy.minScore) reasons.push(`score ${rep.score} < ${policy.minScore}`);
  if (policy.minCompletedJobs != null && rep.counts.completed < policy.minCompletedJobs) reasons.push(`completed ${rep.counts.completed} < ${policy.minCompletedJobs}`);
  if (policy.maxDisputeRate != null && rep.dimensions.disputeRate > policy.maxDisputeRate) reasons.push(`disputeRate ${rep.dimensions.disputeRate.toFixed(2)} > ${policy.maxDisputeRate}`);
  return { ok: reasons.length === 0, reasons };
}

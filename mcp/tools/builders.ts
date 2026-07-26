import { Interface, parseEther, id as keccakId, ZeroHash } from "ethers";
import type { Ctx } from "../sources.ts";
import { CHAIN_ID, addrLink } from "../evidence.ts";
import {
  AGENT_JOBS_ADDRESS, AGENT_JOBS_ABI,
  REPUTATION_REGISTRY_ADDRESS, REPUTATION_REGISTRY_ABI,
  AGENT_PAY_V3_VAULT_ABI,
} from "./_config.ts";

const jobsIface = new Interface(AGENT_JOBS_ABI);
const repIface = new Interface(REPUTATION_REGISTRY_ABI);
const vaultIface = new Interface(AGENT_PAY_V3_VAULT_ABI);
const bytes32 = (v?: string) => (v && /^0x[0-9a-fA-F]{64}$/.test(v) ? v : v ? keccakId(v) : ZeroHash);

export type Simulator = (to: string, data: string, value: string, from?: string) => Promise<{ ok: boolean; gasEstimate: string | null; revertReason: string | null }>;

// default simulator: eth_call + estimateGas via ctx provider
export function defaultSimulator(ctx: Ctx): Simulator {
  return async (to, data, value, from) => {
    try {
      const p = ctx.provider();
      await p.call({ to, data, value, from });
      let gasEstimate: string | null = null;
      try { gasEstimate = (await p.estimateGas({ to, data, value, from })).toString(); } catch { /* value/from-sensitive */ }
      return { ok: true, gasEstimate, revertReason: null };
    } catch (e: any) {
      return { ok: false, gasEstimate: null, revertReason: e?.shortMessage || e?.reason || String(e?.message || e) };
    }
  };
}

function built(to: string, data: string, value: string, sim: { ok: boolean; gasEstimate: string | null; revertReason: string | null }, tip: number, extra: Record<string, any> = {}) {
  return { chainId: CHAIN_ID, to, data, value, simulation: sim, evidence: { chainId: CHAIN_ID, source: "rpc" as const, block: tip, contract: to, links: { explorer: addrLink(to) } }, next: "Sign this transaction with the agent wallet, then call get_receipt.", ...extra };
}

export async function buildCreateJob(
  input: { client?: string; provider: string; evaluator: string; budget: string; expiry: number; descHash?: string; providerAgentId?: string },
  ctx: Ctx, simulator?: Simulator,
) {
  const tip = await ctx.tipBlock();
  const value = parseEther(String(input.budget)).toString();
  const data = jobsIface.encodeFunctionData("createJob", [input.provider, input.evaluator, input.expiry, bytes32(input.descHash), BigInt(input.providerAgentId ?? "0")]);
  const sim = await (simulator ?? defaultSimulator(ctx))(AGENT_JOBS_ADDRESS, data, value, input.client);
  return built(AGENT_JOBS_ADDRESS, data, value, sim, tip);
}

export async function buildSubmitJob(input: { jobId: string; deliverableHash: string }, ctx: Ctx, simulator?: Simulator) {
  const tip = await ctx.tipBlock();
  const data = jobsIface.encodeFunctionData("submit", [BigInt(input.jobId), bytes32(input.deliverableHash)]);
  const sim = await (simulator ?? defaultSimulator(ctx))(AGENT_JOBS_ADDRESS, data, "0");
  return built(AGENT_JOBS_ADDRESS, data, "0", sim, tip);
}

export async function buildEvaluateJob(input: { jobId: string; approve: boolean; evidenceHash?: string }, ctx: Ctx, simulator?: Simulator) {
  const tip = await ctx.tipBlock();
  const data = jobsIface.encodeFunctionData("evaluate", [BigInt(input.jobId), input.approve, bytes32(input.evidenceHash)]);
  const sim = await (simulator ?? defaultSimulator(ctx))(AGENT_JOBS_ADDRESS, data, "0");
  return built(AGENT_JOBS_ADDRESS, data, "0", sim, tip);
}

export async function buildLeaveFeedback(
  input: { agentId: string; score: number; jobId?: string; filehash?: string },
  ctx: Ctx, simulator?: Simulator,
) {
  const tip = await ctx.tipBlock();
  const data = repIface.encodeFunctionData("giveFeedback", [
    BigInt(input.agentId), BigInt(Math.round(input.score)), 0, "arcjob", input.jobId ?? "", "", "", bytes32(input.filehash),
  ]);
  const sim = await (simulator ?? defaultSimulator(ctx))(REPUTATION_REGISTRY_ADDRESS, data, "0");
  return built(REPUTATION_REGISTRY_ADDRESS, data, "0", sim, tip);
}

export async function quotePayment(
  input: { vault: string; agentId: string; merchant: string; amount: string; invoiceId?: string },
  ctx: Ctx, simulator?: Simulator, policyReader?: (vault: string, agentId: string, merchant: string) => Promise<any>,
) {
  const tip = await ctx.tipBlock();
  const amountWei = parseEther(String(input.amount));
  const invoiceId = bytes32(input.invoiceId || `arcpay:${input.vault}:${Date.now()}`);
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const data = vaultIface.encodeFunctionData("payInvoice", [invoiceId, input.merchant, amountWei, expiresAt, bytes32(input.invoiceId || "memo")]);

  // advisory policy preview
  let policyCheck = { ok: true, reasons: [] as string[] };
  try {
    const { Contract } = await import("ethers");
    const read = policyReader ?? (async (v: string, a: string, m: string) => {
      const c = new Contract(v, AGENT_PAY_V3_VAULT_ABI, ctx.provider());
      const [p, allowed] = await Promise.all([c.policies(a), c.merchantAllowed(a, m)]);
      return { p, allowed };
    });
    const { p, allowed } = await read(input.vault, input.agentId, input.merchant);
    if (!p.enabled) policyCheck.reasons.push("policy disabled");
    if (!allowed) policyCheck.reasons.push("merchant not allowed");
    if (amountWei > p.perPayment) policyCheck.reasons.push("amount exceeds perPayment");
    if (p.spentToday + amountWei > p.dailyLimit) policyCheck.reasons.push("would exceed dailyLimit");
    policyCheck.ok = policyCheck.reasons.length === 0;
  } catch (e: any) {
    policyCheck = { ok: false, reasons: [`policy read failed: ${e?.message || e}`] };
  }

  const sim = await (simulator ?? defaultSimulator(ctx))(input.vault, data, "0", input.agentId);
  return built(input.vault, data, "0", sim, tip, { amount: input.amount, merchant: input.merchant, policyCheck });
}

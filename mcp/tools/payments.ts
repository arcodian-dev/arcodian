import { Contract, formatEther } from "ethers";
import type { Ctx } from "../sources.ts";
import { rpcEvidence, addrLink, txLink } from "../evidence.ts";
import { AGENT_PAY_V3_VAULT_ABI } from "./_config.ts";

const s = (x: any) => (x == null ? null : x.toString());

export async function inspectVault(input: { vault: string }, ctx: Ctx, reader?: (v: string) => Promise<any>) {
  const tip = await ctx.tipBlock();
  const read = reader ?? (async (v: string) => {
    const c = new Contract(v, AGENT_PAY_V3_VAULT_ABI, ctx.provider());
    const [owner, balance] = await Promise.all([c.owner(), ctx.provider().getBalance(v)]);
    return { owner, balance };
  });
  const r = await read(input.vault);
  return { vault: input.vault, owner: r.owner, balance: formatEther(r.balance), evidence: rpcEvidence(tip, input.vault, { explorer: addrLink(input.vault) }) };
}

export type PolicyReader = (vault: string, agentId: string, merchant?: string) => Promise<{ policy: any; merchantAllowed: boolean | null }>;
export async function inspectSpendingPolicy(
  input: { vault: string; agentId: string; merchant?: string },
  ctx: Ctx,
  reader?: PolicyReader,
) {
  const tip = await ctx.tipBlock();
  const read: PolicyReader = reader ?? (async (vault, agentId, merchant) => {
    const c = new Contract(vault, AGENT_PAY_V3_VAULT_ABI, ctx.provider());
    const policy = await c.policies(agentId);
    const merchantAllowed = merchant ? await c.merchantAllowed(agentId, merchant) : null;
    return { policy, merchantAllowed };
  });
  const { policy, merchantAllowed } = await read(input.vault, input.agentId, input.merchant);
  return {
    vault: input.vault, agentId: String(input.agentId),
    enabled: Boolean(policy.enabled),
    perPayment: s(policy.perPayment), dailyLimit: s(policy.dailyLimit),
    spentToday: s(policy.spentToday), validUntil: Number(policy.validUntil),
    merchantAllowed,
    evidence: rpcEvidence(tip, input.vault, { explorer: addrLink(input.vault) }),
  };
}

export async function getReceipt(input: { txHashOrInvoiceId: string }, ctx: Ctx, reader?: (h: string) => Promise<any>) {
  const tip = await ctx.tipBlock();
  const val = input.txHashOrInvoiceId;
  const isTx = /^0x[0-9a-fA-F]{64}$/.test(val);
  const read = reader ?? (async (h: string) => (isTx ? ctx.provider().getTransactionReceipt(h) : null));
  const rcpt = await read(val);
  if (!rcpt) return { found: false, query: val, note: isTx ? "no receipt for tx hash" : "invoiceId lookup requires a tx hash in v1", evidence: rpcEvidence(tip) };
  return {
    found: true, txHash: rcpt.hash ?? val, status: rcpt.status === 1 ? "success" : "failed",
    blockNumber: Number(rcpt.blockNumber), from: rcpt.from, to: rcpt.to,
    evidence: rpcEvidence(tip, rcpt.to ?? undefined, { explorer: txLink(rcpt.hash ?? val) }),
  };
}

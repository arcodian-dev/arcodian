import { Contract } from "ethers";
import type { Ctx } from "../sources.ts";
import { indexEvidence, addrLink } from "../evidence.ts";
import {
  AGENT_PASSPORT_ABI,
  AGENT_PASSPORT_ADDRESS,
  IDENTITY_REGISTRY_ADDRESS,
  IDENTITY_REGISTRY_ABI,
} from "./_config.ts";

export type FindAgentsInput = { capability?: string; minReputation?: number; requireValidation?: boolean; limit?: number };

export async function findAgents(input: FindAgentsInput, ctx: Ctx) {
  const [agentsIdx, repIdx, tip] = await Promise.all([ctx.loadIndex("agents"), ctx.loadIndex("reputation"), ctx.tipBlock()]);
  const reps = new Map<string, any>((repIdx.agents || []).map((r: any) => [String(r.agentId), r]));
  let rows = Object.values(agentsIdx.agents || {}).map((a: any) => {
    const r = reps.get(String(a.agentId));
    return {
      agentId: String(a.agentId), owner: a.owner, wallet: a.wallet,
      score: r?.score ?? null, confidence: r?.confidence ?? null,
      dimensions: r?.dimensions ?? null, validationCount: r?.validation?.independentCount ?? 0,
      flags: r?.flags ?? [],
    };
  });
  if (input.minReputation != null) rows = rows.filter((x) => (x.score ?? -1) >= input.minReputation!);
  if (input.requireValidation) rows = rows.filter((x) => x.validationCount > 0);
  rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const limit = input.limit ?? 20;
  rows = rows.slice(0, limit);

  // capability filter: capabilities are NOT indexed — fetch metadata for the shortlist only.
  if (input.capability) {
    const want = input.capability.toLowerCase();
    const withCaps = await Promise.all(rows.map(async (x) => {
      const caps = await agentCapabilities(x.agentId, ctx).catch(() => []);
      return { ...x, capabilities: caps };
    }));
    rows = withCaps.filter((x) => (x.capabilities || []).some((c: string) => String(c).toLowerCase() === want));
  }

  const idxBlock = Math.min(agentsIdx.indexedBlock ?? tip, repIdx.indexedBlock ?? tip);
  return {
    agents: rows.map((x) => ({ ...x, links: { explorer: addrLink(x.owner) } })),
    evidence: indexEvidence(tip, idxBlock),
  };
}

async function agentCapabilities(agentId: string, ctx: Ctx): Promise<string[]> {
  const { tokenURI } = await resolveIdentity(agentId, ctx);
  const url = tokenURI.startsWith("ipfs://") ? `https://gateway.pinata.cloud/ipfs/${tokenURI.slice(7)}` : tokenURI;
  const res = await fetch(url);
  if (!res.ok) return [];
  const meta = await res.json();
  return Array.isArray(meta.capabilities) ? meta.capabilities : [];
}

export type ResolveIdentity = (agentId: string, ctx: Ctx) => Promise<{ owner: string; wallet: string; tokenURI: string; integrity: string }>;

export async function resolveIdentity(agentId: string, ctx: Ctx) {
  const reg = new Contract(IDENTITY_REGISTRY_ADDRESS, IDENTITY_REGISTRY_ABI, ctx.provider());
  const passport = new Contract(AGENT_PASSPORT_ADDRESS, AGENT_PASSPORT_ABI, ctx.provider());
  const [owner, tokenURI, wallet] = await Promise.all([
    reg.ownerOf(agentId),
    reg.tokenURI(agentId),
    passport.walletOf(agentId),
  ]);
  return { owner, wallet, tokenURI, integrity: "unchecked" };
}

export async function inspectAgent(input: { agentId: string }, ctx: Ctx, resolver: ResolveIdentity = resolveIdentity) {
  const [repIdx, tip, identity] = await Promise.all([ctx.loadIndex("reputation"), ctx.tipBlock(), resolver(input.agentId, ctx)]);
  const rep = (repIdx.agents || []).find((r: any) => String(r.agentId) === String(input.agentId)) || null;
  return {
    agentId: String(input.agentId),
    identity,
    reputation: rep ? { score: rep.score, confidence: rep.confidence, dimensions: rep.dimensions, flags: rep.flags, feedback: rep.feedback, validation: rep.validation } : null,
    evidence: indexEvidence(tip, repIdx.indexedBlock ?? tip, IDENTITY_REGISTRY_ADDRESS, { explorer: addrLink(identity.owner) }),
  };
}

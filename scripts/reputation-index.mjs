// Phase C reputation aggregator. Drives off view functions keyed by our providers'
// agentIds (from jobs.json) — no event scanning. Runs the pure src/lib/reputation.ts
// logic so scores match the app + tests exactly. Requires Node >=22 (native TS strip).
import { JsonRpcProvider, Contract, ZeroAddress } from "ethers";
import { readFileSync, writeFileSync } from "node:fs";
import { scoreProvider, classifyFeedback, classifyValidation, WEIGHTS, K } from "../src/lib/reputation.ts";

const RPC = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network/";
const JOBS_FEED = process.env.JOB_INDEX_OUT || "public/developers/jobs.json";
const OUT = process.env.REPUTATION_INDEX_OUT || "public/developers/reputation.json";
const IDENTITY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const PASSPORT = "0xDaCEF31ca7C5B1cebB5516f541cfF05E17eC2cCf";
const REP = "0x8004B663056A597Dffe9eCcC1965A193B7388713";
const VAL = "0x8004Cb1BF31DAf7788923b405b754f57acEB4272";

const ID_ABI = ["function ownerOf(uint256) view returns(address)"];
const PP_ABI = ["function agentIdOf(address) view returns(uint256)"];
const REP_ABI = [
  "function getClients(uint256 agentId) view returns(address[])",
  "function getLastIndex(uint256 agentId,address client) view returns(uint64)",
  "function readFeedback(uint256 agentId,address client,uint64 index) view returns(uint8 score,string tag1,string tag2,string endpoint,bytes32 filehash,bool isRevoked)",
];
const VAL_ABI = [
  "function getAgentValidations(uint256 agentId) view returns(bytes32[])",
  "function getValidationStatus(bytes32 dataHash) view returns(address validator,uint256 agentId,uint8 response,uint256 lastUpdate)",
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function retry(fn, label) {
  for (let a = 0; a < 5; a++) {
    try { return await fn(); }
    catch (e) { const m = String(e?.message || e); if (/limit reached|rate|429|-32011/.test(m)) { await sleep(1200 * (a + 1)); continue; } throw new Error(`${label}: ${m}`); }
  }
  throw new Error(`${label}: retries exhausted`);
}
const lc = x => (x || "").toLowerCase();

async function main() {
  const provider = new JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
  const feed = JSON.parse(readFileSync(JOBS_FEED, "utf8"));
  const jobs = (feed.jobs || []).map(j => ({
    jobId: j.jobId, client: j.client, provider: j.provider, evaluator: j.evaluator,
    providerAgentId: String(j.providerAgentId || "0"), status: j.status, budget: j.budget,
    createdAt: j.createdAt, expiry: j.expiry, submittedAt: j.submittedAt,
    deliverableHash: j.deliverableHash || "0x", evidenceHash: j.evidenceHash,
  }));

  const id = new Contract(IDENTITY, ID_ABI, provider);
  const pp = new Contract(PASSPORT, PP_ABI, provider);
  const rep = new Contract(REP, REP_ABI, provider);
  const val = new Contract(VAL, VAL_ABI, provider);

  // group by provider identity: agentId when present, else provider wallet (objective-only).
  const groups = new Map();
  for (const j of jobs) {
    const key = j.providerAgentId !== "0" ? `agent:${j.providerAgentId}` : `wallet:${lc(j.provider)}`;
    if (!groups.has(key)) groups.set(key, { agentId: j.providerAgentId !== "0" ? j.providerAgentId : null, providerWallet: j.provider, jobs: [] });
    groups.get(key).jobs.push(j);
  }

  // memoized identity resolvers
  const ownerOfAgent = {}; const agentIdOfWallet = {};
  const resolveOwner = async aid => { if (aid == null || aid === "0") return; if (ownerOfAgent[aid] !== undefined) return; try { ownerOfAgent[aid] = lc(await retry(() => id.ownerOf(aid), "ownerOf")); } catch { ownerOfAgent[aid] = ""; } };
  const resolveWalletAgent = async w => { const k = lc(w); if (agentIdOfWallet[k] !== undefined) return; try { const a = (await retry(() => pp.agentIdOf(w), "agentIdOf")).toString(); agentIdOfWallet[k] = a === "0" ? "" : a; if (a !== "0") await resolveOwner(a); } catch { agentIdOfWallet[k] = ""; } };

  const agents = [];
  for (const g of groups.values()) {
    // resolve owners for self-review detection
    if (g.agentId) await resolveOwner(g.agentId);
    for (const j of g.jobs) { await resolveWalletAgent(j.client); await resolveWalletAgent(j.evaluator); }
    const resolvers = { ownerOfAgent, agentIdOfWallet };
    const result = scoreProvider(g.providerWallet, g.jobs, resolvers);

    let feedback = []; let validation = { independentCount: 0, averageScore: 0, items: [] };
    if (g.agentId) {
      // Tier 2 — feedback (view-by-agentId): getClients -> getLastIndex -> readFeedback
      const clients = await retry(() => rep.getClients(g.agentId), "getClients").catch(() => []);
      const raw = [];
      for (const c of clients) {
        const last = Number(await retry(() => rep.getLastIndex(g.agentId, c), "getLastIndex").catch(() => 0));
        for (let i = 1; i <= last; i++) {
          try {
            const f = await retry(() => rep.readFeedback(g.agentId, c, i), "readFeedback");
            if (f.isRevoked) continue;
            raw.push({ agentId: g.agentId, client: c, score: Number(f.score), tag1: f.tag1, tag2: f.tag2, endpoint: f.endpoint, filehash: f.filehash, index: i });
          } catch { /* skip unreadable index */ }
        }
      }
      feedback = classifyFeedback(g.agentId, raw, g.jobs);

      // Tier 3 — validation (view-by-agentId): getAgentValidations -> getValidationStatus
      const hashes = await retry(() => val.getAgentValidations(g.agentId), "getAgentValidations").catch(() => []);
      const rawV = [];
      for (const h of hashes) {
        try {
          const s = await retry(() => val.getValidationStatus(h), "getValidationStatus");
          if (s.validator === ZeroAddress) continue;
          rawV.push({ agentId: g.agentId, validator: s.validator, dataHash: h, response: Number(s.response) });
        } catch { /* skip */ }
      }
      const cv = classifyValidation(g.agentId, rawV, g.jobs);
      const ind = cv.filter(v => v.independent);
      validation = {
        independentCount: ind.length,
        averageScore: ind.length ? Math.round(ind.reduce((a, v) => a + v.response, 0) / ind.length) : 0,
        items: cv,
      };
    }

    agents.push({
      agentId: g.agentId, providerWallet: g.providerWallet,
      score: result.score, confidence: result.confidence,
      counts: result.counts, dimensions: result.dimensions, context: result.context,
      flags: result.flags, eligibleJobIds: result.eligibleJobIds, excludedJobIds: result.excludedJobIds,
      feedback, validation,
    });
  }

  agents.sort((a, b) => b.score - a.score);
  const tip = await provider.getBlockNumber();
  writeFileSync(OUT, JSON.stringify({ indexedBlock: tip, generatedAt: new Date().toISOString(), weights: WEIGHTS, K, count: agents.length, agents }, null, 0));
  console.log(`scored ${agents.length} providers through block ${tip}`);
  await provider.destroy?.();
}
main().catch(e => { console.error(e); process.exit(1); });

import { JsonRpcProvider, Interface, formatEther } from "ethers";
import { readFileSync, writeFileSync } from "node:fs";

const RPC = process.env.ARC_RPC_URL || "https://arcodian.fun/api/rpc.php";
const REGISTRY = process.env.SERVICE_REGISTRY_ADDRESS;
const VAULT = process.env.PAY_VAULT_ADDRESS;
const OUT = process.env.SERVICE_INDEX_OUT || "public/developers/services.json";
const REP = process.env.REPUTATION_OUT || "public/developers/reputation.json";
const STATE = `${OUT}.state.json`;
const DEPLOY_BLOCK = Number(process.env.SERVICE_DEPLOY_BLOCK || 0);
const CHUNK = 9_500;
const MAX_CATCHUP = Number(process.env.SERVICE_MAX_CATCHUP || 30_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const iface = new Interface([
  "event ServiceRegistered(bytes32 indexed serviceId,address indexed provider,uint256 indexed agentId,uint256 price,string endpointURI,string metadataURI)",
  "event ServiceUpdated(bytes32 indexed serviceId,uint256 price,string endpointURI,string metadataURI)",
  "event ServiceDeactivated(bytes32 indexed serviceId)",
  "event Redeemed(address indexed provider,address indexed payer,uint256 cumulative,uint256 paid,uint256 fee)",
]);
const T = {
  registered: iface.getEvent("ServiceRegistered").topicHash,
  updated: iface.getEvent("ServiceUpdated").topicHash,
  deactivated: iface.getEvent("ServiceDeactivated").topicHash,
  redeemed: iface.getEvent("Redeemed").topicHash,
};

export function joinReputation(services, rep) {
  return services
    .map((s) => ({ ...s, reputation: Number(rep[String(s.agentId)] ?? 0) }))
    .sort((a, b) => b.reputation - a.reputation);
}

function loadState() { try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return null; } }
function loadReputation() {
  try {
    const d = JSON.parse(readFileSync(REP, "utf8"));
    const map = {}; const arr = Array.isArray(d) ? d : (d.agents || []);
    for (const a of arr) map[String(a.agentId)] = Number(a.score ?? a.reputation ?? 0);
    return map;
  } catch { return {}; }
}
async function getLogs(provider, params) {
  for (let a = 0; a < 5; a++) {
    try { return await provider.getLogs(params); }
    catch (e) { const m = String(e?.message || e); if (/limit reached|rate|429|-32011/.test(m)) { await sleep(1500 * (a + 1)); continue; } throw e; }
  }
  throw Error("getLogs retries exhausted");
}

async function main() {
  const provider = new JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
  const tip = await provider.getBlockNumber();
  const prev = loadState();
  const services = prev?.services || {};
  const volumeByProvider = prev?.volumeByProvider || {};
  let start = prev ? prev.indexedBlock + 1 : Math.max(DEPLOY_BLOCK, tip - MAX_CATCHUP);
  for (let from = start; from <= tip; from += CHUNK) {
    const to = Math.min(tip, from + CHUNK - 1);
    const regLogs = await getLogs(provider, { address: REGISTRY, topics: [[T.registered, T.updated, T.deactivated]], fromBlock: from, toBlock: to });
    const vLogs = await getLogs(provider, { address: VAULT, topics: [[T.redeemed]], fromBlock: from, toBlock: to });
    for (const l of [...regLogs, ...vLogs].sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index)) {
      const e = iface.parseLog(l);
      if (e.name === "Redeemed") {
        const key = String(e.args.provider).toLowerCase();
        volumeByProvider[key] = (BigInt(volumeByProvider[key] || "0") + e.args.paid + e.args.fee).toString();
        continue;
      }
      const id = e.args.serviceId.toString();
      const s = services[id] || { serviceId: id };
      if (e.name === "ServiceRegistered") {
        s.provider = e.args.provider; s.agentId = e.args.agentId.toString();
        s.price = formatEther(e.args.price); s.endpointURI = e.args.endpointURI; s.metadataURI = e.args.metadataURI; s.active = true;
      } else if (e.name === "ServiceUpdated") {
        s.price = formatEther(e.args.price); s.endpointURI = e.args.endpointURI; s.metadataURI = e.args.metadataURI;
      } else if (e.name === "ServiceDeactivated") { s.active = false; }
      services[id] = s;
    }
  }
  const withVol = Object.values(services).map((s) => ({ ...s, volume: formatEther(BigInt(volumeByProvider[String(s.provider).toLowerCase()] || "0")) }));
  const list = joinReputation(withVol, loadReputation());
  writeFileSync(OUT, JSON.stringify({ indexedBlock: tip, count: list.length, services: list }, null, 0));
  writeFileSync(STATE, JSON.stringify({ indexedBlock: tip, services, volumeByProvider }));
  console.log(`indexed ${list.length} services through block ${tip}`);
  await provider.destroy?.();
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });

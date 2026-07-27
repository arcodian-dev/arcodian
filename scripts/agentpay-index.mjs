import fs from "node:fs";
import path from "node:path";
import { Contract, Interface, JsonRpcProvider, formatEther } from "ethers";

// Must be an ARCHIVE endpoint: a first run replays logs from the factory's deploy
// block, and the pruned nodes answer eth_getLogs with code 4444 "pruned history
// unavailable". rpc.testnet.arc.network retains full history.
const RPC = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network/";
const FACTORY = "0x27c722F643ea787f7425449AF8B03601B90815eD";
const ARCPAY = "0x5e3d1b63213b8608539116d1c6248a36819684b5";
const DEPLOY_BLOCK = 53_043_000;
// The node caps eth_getLogs at a 10,000-block range, so every scan is windowed.
const CHUNK = 9_500;
// Arc produces ~1.7 blocks/second. If the checkpoint is far behind (the indexer
// was down), skip ahead rather than replaying days of history — a public stats
// page is better slightly gapped than permanently stuck catching up.
const MAX_CATCHUP = Number(process.env.AGENTPAY_MAX_CATCHUP || 30_000);
const OUT = process.env.AGENTPAY_INDEX_OUT || path.resolve("public/data/agentpay-index.json");

const provider = new JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });

async function scan(contract, filter, from, to) {
  const out = [];
  for (let start = from; start <= to; start += CHUNK) {
    out.push(...await contract.queryFilter(filter, start, Math.min(to, start + CHUNK - 1)));
  }
  return out;
}

// Resume from the last indexed block instead of replaying all history: Arc makes
// ~1.7 blocks/second, so a full replay is ~60 requests every run and trips the
// RPC request limit. Incrementally we only ever read the new blocks.
function loadPrevious() {
  try {
    const prev = JSON.parse(fs.readFileSync(OUT, "utf8"));
    if (prev && Array.isArray(prev.vaults) && Number.isFinite(prev.indexedBlock)) return prev;
  } catch { /* first run, or unreadable output */ }
  return null;
}

const previous = loadPrevious();
const tip = await provider.getBlockNumber();
const checkpoint = previous ? previous.indexedBlock + 1 : DEPLOY_BLOCK;
const since = Math.max(checkpoint, tip - MAX_CATCHUP);

const factory = new Contract(FACTORY, ["event VaultCreated(address indexed owner,address indexed vault,uint256 initialFunding)"], provider);
const vaultAbi = [
  "event Funded(address indexed from,uint256 amount)",
  "event Withdrawn(address indexed to,uint256 amount)",
  "event AgentPolicySet(address indexed agent,uint256 perPayment,uint256 dailyLimit,uint64 validUntil,bool enabled)",
  "event MerchantPermission(address indexed agent,address indexed merchant,bool allowed)",
  "event AgentInvoicePaid(address indexed agent,bytes32 indexed invoiceId,address indexed merchant,uint256 amount,uint256 spentToday)",
];
const pay = new Contract(ARCPAY, ["function payments(bytes32) view returns(address payer,address merchant,uint128 amount,uint128 fee,uint64 paidAt,bool refunded)"], provider);

const blockTimes = new Map();
async function ts(n) {
  if (!blockTimes.has(n)) blockTimes.set(n, (await provider.getBlock(n)).timestamp);
  return blockTimes.get(n);
}

// Known vaults carry over; only genuinely new ones are discovered each run.
const known = new Map((previous?.vaults || []).map((v) => [v.vault.toLowerCase(), v]));
if (since <= tip) {
  for (const e of await scan(factory, factory.filters.VaultCreated(), since, tip)) {
    const key = e.args.vault.toLowerCase();
    if (!known.has(key)) {
      known.set(key, {
        owner: e.args.owner, vault: e.args.vault, balance: "0",
        createdTx: e.transactionHash, createdBlock: e.blockNumber,
        policies: [], permissions: [], activity: [],
      });
    }
  }
}

// One windowed getLogs covering EVERY vault and EVERY event at once — the node
// accepts an address array and a topic0 OR-set, so a run costs one request per
// 9.5k-block window instead of five per vault.
const vaultIface = new Interface(vaultAbi);
const EVENT_TOPICS = ["Funded", "Withdrawn", "AgentPolicySet", "MerchantPermission", "AgentInvoicePaid"]
  .map((name) => vaultIface.getEvent(name).topicHash);
const byVault = new Map([...known.keys()].map((k) => [k, { funds: [], outs: [], pols: [], merchants: [], pays: [] }]));
const BUCKET = { Funded: "funds", Withdrawn: "outs", AgentPolicySet: "pols", MerchantPermission: "merchants", AgentInvoicePaid: "pays" };

if (known.size && since <= tip) {
  const addresses = [...known.values()].map((v) => v.vault);
  for (let start = since; start <= tip; start += CHUNK) {
    const logs = await provider.getLogs({
      address: addresses, topics: [EVENT_TOPICS],
      fromBlock: start, toBlock: Math.min(tip, start + CHUNK - 1),
    });
    for (const log of logs) {
      const parsed = vaultIface.parseLog(log);
      if (!parsed) continue;
      const bucket = byVault.get(log.address.toLowerCase());
      if (!bucket) continue;
      bucket[BUCKET[parsed.name]].push({ args: parsed.args, transactionHash: log.transactionHash, blockNumber: log.blockNumber });
    }
  }
}

for (const vault of known.values()) {
  const { funds, outs, pols, merchants, pays } = byVault.get(vault.vault.toLowerCase());
  const balance = await provider.getBalance(vault.vault);

  const policyMap = new Map((vault.policies || []).map((p) => [p.agent.toLowerCase(), p]));
  for (const p of pols) {
    policyMap.set(p.args.agent.toLowerCase(), {
      agent: p.args.agent, perPayment: formatEther(p.args.perPayment), dailyLimit: formatEther(p.args.dailyLimit),
      validUntil: Number(p.args.validUntil), enabled: p.args.enabled, tx: p.transactionHash,
    });
  }

  const permissions = [...(vault.permissions || []), ...merchants.map((x) => ({
    agent: x.args.agent, merchant: x.args.merchant, allowed: x.args.allowed, tx: x.transactionHash,
  }))];

  const activity = [...(vault.activity || [])];
  const seen = new Set(activity.map((a) => `${a.tx}:${a.type}`));
  const push = (entry) => { const k = `${entry.tx}:${entry.type}`; if (!seen.has(k)) { seen.add(k); activity.push(entry); } };
  for (const x of funds) push({ type: "funded", amount: formatEther(x.args.amount), counterparty: x.args.from, tx: x.transactionHash, block: x.blockNumber, timestamp: await ts(x.blockNumber) });
  for (const x of outs) push({ type: "withdrawn", amount: formatEther(x.args.amount), counterparty: x.args.to, tx: x.transactionHash, block: x.blockNumber, timestamp: await ts(x.blockNumber) });
  for (const x of pays) {
    const receipt = await pay.payments(x.args.invoiceId);
    push({
      type: receipt.refunded ? "refunded" : "paid", amount: formatEther(x.args.amount), agent: x.args.agent,
      merchant: x.args.merchant, invoiceId: x.args.invoiceId, fee: formatEther(receipt.fee),
      tx: x.transactionHash, block: x.blockNumber, timestamp: await ts(x.blockNumber),
    });
  }
  activity.sort((a, b) => b.block - a.block);

  vault.balance = formatEther(balance);
  vault.policies = [...policyMap.values()];
  vault.permissions = permissions;
  vault.activity = activity;
}

const vaults = [...known.values()];
const payload = {
  version: 1, chainId: 5042002, factory: FACTORY, arcPay: ARCPAY,
  indexedAt: new Date().toISOString(), indexedBlock: tip,
  counts: {
    vaults: vaults.length,
    agents: vaults.reduce((n, v) => n + v.policies.length, 0),
    payments: vaults.reduce((n, v) => n + v.activity.filter((x) => x.type === "paid" || x.type === "refunded").length, 0),
  },
  vaults,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(payload));
console.log(JSON.stringify({ ...payload.counts, from: since, to: tip, incremental: Boolean(previous) }));
provider.destroy();

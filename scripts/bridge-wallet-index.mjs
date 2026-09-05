#!/usr/bin/env node
// Persistent per-wallet index of Arc Mainnet bridge activity, built the same
// incremental way as bridge-stats.mjs (cursor per chain, never rescans from
// genesis). bridge-history.php needs this because a live per-request
// eth_getLogs scan across all 5 routers' full block ranges is far too slow
// to run inside one HTTP request — confirmed 2026-09-05: a single lookup
// against Arbitrum's ~12.5M-block range alone took over 100s and got cut
// off by the request timeout before returning anything. Every route in
// Arcodian starts or ends on Arc, and every router emits BridgeStarted with
// sender/mintRecipient/destinationDomain all indexed, so one full scan (not
// filtered by address — we need the whole address->rows map, not one
// wallet) is enough to serve every future per-wallet lookup instantly.
import { JsonRpcProvider } from "ethers";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const TOPIC0 = "0x9a849c538c75ea01dca14236efd2fc30b55f3ff5395d06e2ecf28bb0830dca9f"; // BridgeStarted(address indexed,bytes32 indexed,uint32 indexed,uint256,uint256,uint256)
const OUT = process.env.BRIDGE_WALLET_INDEX_OUTPUT || "/www/wwwroot/arcodian.fun/shared/data/bridge-wallet-index.json";
const STATE_PATH = process.env.BRIDGE_WALLET_INDEX_STATE || "/www/wwwroot/arcodian.fun/shared/data/bridge-wallet-index-state.json";
// domain is the CCTP domain this router's own chain sits on (used as the
// sourceDomain for IRIS attestation lookups by the PHP endpoint that reads
// this file's output).
const ROUTERS = [
  { chainId: 1, domain: 0, address: "0x9fc12b77ae41181c98563e5ae5645ae8a0f6eddd", rpcs: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"], fromBlock: 25650790, isArc: false },
  { chainId: 10, domain: 2, address: "0x66cc4767ec52ff09d8bda7abfccdea6ab9b70967", rpcs: ["https://optimism-rpc.publicnode.com", "https://mainnet.optimism.io"], fromBlock: 154938740, isArc: false },
  { chainId: 42161, domain: 3, address: "0x66cc4767ec52ff09d8bda7abfccdea6ab9b70967", rpcs: ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc"], fromBlock: 489538042, isArc: false },
  { chainId: 8453, domain: 6, address: "0x274454aa0413b96651983c5efd6817cb30968e71", rpcs: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"], fromBlock: 49343417, isArc: false },
  { chainId: 5042, domain: 26, address: "0xc35deb937f5056a0e034f10e21094878485caee7", rpcs: ["https://arc-rpc.stakeme.pro", "https://arcodian.fun/api/rpc-mainnet.php"], fromBlock: 13126352, isArc: true },
];
const DOMAIN_TO_CHAIN = { 0: 1, 2: 10, 3: 42161, 6: 8453, 26: 5042 };

// Arbitrum alone spans ~12.5M blocks since the router's deploy block at
// ~2026-07-31 (fast finality = fast block production) — far too many to
// request in 5k chunks without timing this script out too. Indexed-topic
// filters keep the RESPONSE tiny regardless of window size, so start wide
// and only shrink on an actual rejection.
const START_CHUNK = 200_000;
const MIN_CHUNK = 2_000;
const MAX_CHUNKS_PER_RUN = 120; // bounds one run's wall time; the cursor persists so the rest is picked up next run

function loadJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

async function scanChunked(provider, address, fromBlock, toBlock) {
  const logs = [];
  let chunk = START_CHUNK, start = fromBlock, spent = 0;
  while (start <= toBlock && spent < MAX_CHUNKS_PER_RUN) {
    spent++;
    const end = Math.min(start + chunk - 1, toBlock);
    try {
      const found = await provider.send("eth_getLogs", [{ address, topics: [TOPIC0], fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}` }]);
      logs.push(...found);
      start = end + 1;
    } catch (error) {
      if (chunk > MIN_CHUNK) { chunk = Math.max(MIN_CHUNK, Math.floor(chunk / 4)); continue; }
      throw error;
    }
  }
  return { logs, reachedBlock: Math.min(start - 1, toBlock) };
}

async function scanRouter(router, priorCursor) {
  const startBlock = priorCursor ? priorCursor + 1 : router.fromBlock;
  let lastError;
  for (const rpc of router.rpcs) {
    const provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true, batchMaxCount: 1 });
    try {
      const tip = await provider.getBlockNumber();
      if (startBlock > tip) return { rows: [], cursor: priorCursor ?? router.fromBlock - 1, ok: true };
      const { logs, reachedBlock } = await scanChunked(provider, router.address, startBlock, tip);
      const rows = logs.map((log) => {
        const sender = `0x${log.topics[1].slice(-40)}`.toLowerCase();
        const domainHex = log.topics[3] || "0x0";
        const destDomain = parseInt(domainHex.slice(-8), 16);
        const data = log.data.slice(2);
        const burnHex = data.slice(128, 192).replace(/^0+/, "") || "0";
        const amount = BigInt(`0x${burnHex}`).toString();
        const fromChainId = router.isArc ? 5042 : router.chainId;
        const toChainId = router.isArc ? (DOMAIN_TO_CHAIN[destDomain] ?? 0) : 5042;
        const sourceDomain = router.isArc ? 26 : router.domain;
        return { sender, burnHash: log.transactionHash.toLowerCase(), fromChainId, toChainId, sourceDomain, amount, block: Number(log.blockNumber) };
      });
      return { rows, cursor: reachedBlock, ok: true };
    } catch (error) {
      lastError = error;
    } finally {
      provider.destroy();
    }
  }
  return { rows: [], cursor: priorCursor ?? router.fromBlock - 1, ok: false, error: String(lastError?.shortMessage || lastError?.message || lastError) };
}

// Block timestamps are fetched lazily, only for genuinely new rows, and
// cached in state so a re-run never re-fetches one already resolved.
async function timestampFor(router, blockNumber, cache) {
  const key = `${router.chainId}:${blockNumber}`;
  if (cache[key]) return cache[key];
  for (const rpc of router.rpcs) {
    try {
      const provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true, batchMaxCount: 1 });
      try {
        const block = await provider.getBlock(blockNumber);
        if (block) { cache[key] = block.timestamp * 1000; return cache[key]; }
      } finally { provider.destroy(); }
    } catch { /* try next rpc */ }
  }
  return 0;
}

async function main() {
  const state = loadJson(STATE_PATH, { cursors: {}, rows: [], timestamps: {} });
  const timestamps = state.timestamps || {};
  const allRows = [...(state.rows || [])];
  for (const router of ROUTERS) {
    const result = await scanRouter(router, state.cursors?.[router.chainId]);
    for (const row of result.rows) {
      row.createdAt = await timestampFor(router, row.block, timestamps);
      allRows.push(row);
    }
    if (result.ok) state.cursors = { ...state.cursors, [router.chainId]: result.cursor };
    console.log(`${router.isArc ? "Arc Mainnet" : router.chainId}: +${result.rows.length} rows${result.ok ? "" : ` (error: ${result.error})`}`);
  }
  // De-dupe (burnHash+chainId pair is unique per transaction) and cap total
  // retained history — old fully-settled transfers have no ongoing utility
  // once claimed, and this file is re-read in full on every lookup.
  const seen = new Set();
  const deduped = allRows.filter((row) => {
    const key = `${row.burnHash}:${row.fromChainId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 20_000);

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ indexedAt: new Date().toISOString(), count: deduped.length, rows: deduped }));
  writeFileSync(STATE_PATH, JSON.stringify({ cursors: state.cursors, rows: deduped, timestamps }));
  console.log(`Bridge wallet index written: ${OUT} (${deduped.length} rows)`);
}

main().catch((e) => { console.error(e); process.exit(1); });

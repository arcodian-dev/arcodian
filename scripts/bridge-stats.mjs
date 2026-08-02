#!/usr/bin/env node
// Aggregates real on-chain CCTP bridge volume/fees across all 5 deployed
// ArcBridgeRouter contracts (Ethereum/Optimism/Arbitrum/Base + Arc Mainnet)
// into one snapshot JSON the frontend polls, instead of the browser hitting
// 5 different chain RPCs directly (which is slow and, for Arc's RPC in
// particular, rate-limited under any real concurrent load — see the 429s
// hit during manual testing 2026-07-31). Every route in Arcodian starts or
// ends on Arc, so router events split cleanly into two buckets: the Arc
// router's own events are "out of Arc", and every other router's events
// are "into Arc" (their only configured destination).
//
// 2026-07-31 rewrite: the first version rescanned from each router's deploy
// block on every single run. That was fine when the block range was small,
// but it grows every run forever, so it inevitably started timing out /
// getting rejected by free public RPCs (Ethereum 400, Optimism "could not
// coalesce", Base 413 Payload Too Large) — silently dropping those chains'
// "into Arc" totals to zero without ever surfacing an error anywhere. Now
// incremental: a state file persists cumulative totals + the last block
// actually scanned per chain, and each run only queries what's new since
// then. A chain that errors this run just keeps last run's totals and
// retries from the same cursor next time, instead of going to zero.
import { JsonRpcProvider } from "ethers";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const TOPIC0 = "0x9a849c538c75ea01dca14236efd2fc30b55f3ff5395d06e2ecf28bb0830dca9f"; // BridgeStarted(address,bytes32,uint32,uint256,uint256,uint256)
const OUT = process.env.BRIDGE_STATS_OUTPUT || "/www/wwwroot/arcodian.fun/shared/data/bridge-stats.json";
const STATE_PATH = process.env.BRIDGE_STATS_STATE || "/www/wwwroot/arcodian.fun/shared/data/bridge-stats-state.json";
const CHAIN_NAMES = { 1: "Ethereum", 10: "Optimism", 42161: "Arbitrum", 8453: "Base", 5042: "Arc Mainnet" };

const ROUTERS = [
  { chainId: 1, address: "0x9fc12b77ae41181c98563e5ae5645ae8a0f6eddd", rpcs: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"], fromBlock: 25650790, direction: "in" },
  { chainId: 10, address: "0x66cc4767ec52ff09d8bda7abfccdea6ab9b70967", rpcs: ["https://optimism-rpc.publicnode.com", "https://mainnet.optimism.io"], fromBlock: 154938740, direction: "in" },
  { chainId: 42161, address: "0x66cc4767ec52ff09d8bda7abfccdea6ab9b70967", rpcs: ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc"], fromBlock: 489538042, direction: "in" },
  { chainId: 8453, address: "0x274454aa0413b96651983c5efd6817cb30968e71", rpcs: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"], fromBlock: 49343417, direction: "in" },
  { chainId: 5042, address: "0xc35deb937f5056a0e034f10e21094878485caee7", rpcs: ["https://arc-rpc.stakeme.pro"], fromBlock: 13126352, direction: "out" },
];
// direction is named from Arc's point of view: a router on Ethereum/OP/ARB/Base
// only ever bridges INTO Arc; the Arc router only ever bridges OUT of Arc.

const CHUNK = 5_000; // conservative — Arc's own RPC caps eth_getLogs at 100k; smaller keeps busy chains' response payloads small too

function loadState() {
  try { return JSON.parse(readFileSync(STATE_PATH, "utf8")); } catch { return {}; }
}

async function getLogsChunked(provider, address, fromBlock, toBlock) {
  const logs = [];
  for (let start = fromBlock; start <= toBlock; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, toBlock);
    const chunk = await provider.send("eth_getLogs", [{ address, topics: [TOPIC0], fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}` }]);
    logs.push(...chunk);
  }
  return logs;
}

async function scanWith(rpc, router, fromBlock) {
  const provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true, batchMaxCount: 1 });
  try {
    const tip = await provider.getBlockNumber();
    if (fromBlock > tip) return { logs: [], tip };
    const logs = await getLogsChunked(provider, router.address, fromBlock, tip);
    return { logs, tip };
  } finally {
    provider.destroy();
  }
}

async function scanRouter(router, prior) {
  const startBlock = prior?.scannedToBlock ? prior.scannedToBlock + 1 : router.fromBlock;
  let lastError;
  for (const rpc of router.rpcs) {
    try {
      const { logs, tip } = await scanWith(rpc, router, startBlock);
      const senders = new Set(prior?.senders || []);
      let grossTotal = BigInt(prior?.grossTotalRaw || 0), feeTotal = BigInt(prior?.feeTotalRaw || 0), burnTotal = BigInt(prior?.burnTotalRaw || 0);
      const newTxs = logs.map((log) => {
        const sender = `0x${log.topics[1].slice(-40)}`;
        senders.add(sender.toLowerCase());
        const data = log.data.slice(2);
        const gross = BigInt(`0x${data.slice(0, 64)}`);
        const fee = BigInt(`0x${data.slice(64, 128)}`);
        const burn = BigInt(`0x${data.slice(128, 192)}`);
        grossTotal += gross; feeTotal += fee; burnTotal += burn;
        return { tx: log.transactionHash, block: Number(log.blockNumber), sender };
      });
      const recentTxs = [...(prior?.recentTxs || []), ...newTxs].slice(-5);
      const txCount = (prior?.txCount || 0) + logs.length;
      return {
        chainId: router.chainId,
        chainName: CHAIN_NAMES[router.chainId],
        direction: router.direction,
        txCount,
        uniqueSenders: senders.size,
        grossUsd: Number(grossTotal) / 1e6,
        feeUsd: Number(feeTotal) / 1e6,
        netUsd: Number(burnTotal) / 1e6,
        scannedToBlock: tip,
        recentTxs,
        ok: true,
        // raw state carried between runs — not part of the public shape consumers read
        _state: { scannedToBlock: tip, senders: [...senders], grossTotalRaw: grossTotal.toString(), feeTotalRaw: feeTotal.toString(), burnTotalRaw: burnTotal.toString(), recentTxs, txCount },
      };
    } catch (error) {
      lastError = error;
    }
  }
  // Every RPC failed this run — keep prior totals (if any) rather than
  // reporting zero, but flag it wasn't refreshed.
  if (prior) {
    return {
      chainId: router.chainId, chainName: CHAIN_NAMES[router.chainId], direction: router.direction,
      txCount: prior.txCount || 0, uniqueSenders: (prior.senders || []).length,
      grossUsd: Number(BigInt(prior.grossTotalRaw || 0)) / 1e6, feeUsd: Number(BigInt(prior.feeTotalRaw || 0)) / 1e6, netUsd: Number(BigInt(prior.burnTotalRaw || 0)) / 1e6,
      scannedToBlock: prior.scannedToBlock, recentTxs: prior.recentTxs || [],
      ok: true, stale: true, error: String(lastError?.shortMessage || lastError?.message || lastError),
      _state: prior,
    };
  }
  return { chainId: router.chainId, chainName: CHAIN_NAMES[router.chainId], direction: router.direction, ok: false, error: String(lastError?.shortMessage || lastError?.message || lastError) };
}

async function main() {
  const priorState = loadState();
  const perChain = await Promise.all(ROUTERS.map((router) => scanRouter(router, priorState[router.chainId])));
  const nextState = {};
  for (const row of perChain) if (row._state) nextState[row.chainId] = row._state;
  const publicChain = perChain.map(({ _state, ...rest }) => rest);
  const outOfArc = publicChain.filter((c) => c.direction === "out" && c.ok);
  const intoArc = publicChain.filter((c) => c.direction === "in" && c.ok);
  const sum = (rows, key) => rows.reduce((s, r) => s + (r[key] || 0), 0);
  const payload = {
    version: 2,
    indexedAt: new Date().toISOString(),
    outOfArc: {
      grossUsd: sum(outOfArc, "grossUsd"),
      feeUsd: sum(outOfArc, "feeUsd"),
      txCount: sum(outOfArc, "txCount"),
    },
    intoArc: {
      grossUsd: sum(intoArc, "grossUsd"),
      feeUsd: sum(intoArc, "feeUsd"),
      txCount: sum(intoArc, "txCount"),
    },
    totalFeeUsd: sum(publicChain.filter((c) => c.ok), "feeUsd"),
    totalTxCount: sum(publicChain.filter((c) => c.ok), "txCount"),
    perChain: publicChain,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(payload, null, 2));
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(nextState, null, 2));
  console.log(`Bridge stats written: ${OUT} (${payload.totalTxCount} tx, $${payload.totalFeeUsd.toFixed(4)} fees)`);
}

main().catch((e) => { console.error(e); process.exit(1); });

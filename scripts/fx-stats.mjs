#!/usr/bin/env node
// Indexes the Arc FX pool (USDC/EURC) into a small JSON the frontend serves as
// trust stats: TVL, provider count, deposits, lifetime + 7d volume, fees to LPs,
// and an APR annualized from realized 7d fees. Every figure is derived from
// on-chain reserves, protocol-fee accounting and events — nothing is invented.
//
// getLogs is range-limited on the public RPC (413 over wide spans), so events
// are read in bounded chunks from the pool's deploy block, found by binary
// search on getCode. Raw events are cached beside the public file (like
// arcpay-stats.mjs / job-index.mjs) so each run only reads blocks added since
// the last one — replaying the whole history every run is what left this
// indexer's systemd timer unable to ever finish once the pool had a few
// thousand blocks of history: every cold run got killed by the service's own
// start timeout before a full rescan could complete.

import { JsonRpcProvider, Contract, id, AbiCoder } from "ethers";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const RPC = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network/";
const POOL = process.env.ARC_FX_POOL || "0x982D61ddCAb6169d82B3e37A4E4158f1982E5447";
const OUT = process.env.FX_STATS_OUTPUT || "/www/wwwroot/arcodian.fun/shared/data/fx-stats.json";
const STATE = `${OUT}.state.json`;
const MAX_CATCHUP = Number(process.env.FX_MAX_CATCHUP || 30_000);
const CHUNK = 9000;

const provider = new JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
const abi = [
  "function reserveUsdc() view returns (uint256)",
  "function reserveEurc() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function protocolUsdc() view returns (uint256)",
  "function protocolEurc() view returns (uint256)",
];
const ADDED = id("LiquidityAdded(address,uint256,uint256,uint256)");
const SWAPPED = id("Swapped(address,bool,uint256,uint256,uint256)");
const coder = AbiCoder.defaultAbiCoder();
const usd = (units) => Number(units) / 1e6; // 6-dec stablecoin → USD (EURC treated ~$1)

async function findDeployBlock(tip) {
  let lo = 0, hi = tip;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const code = await provider.getCode(POOL, mid);
    if (code && code !== "0x") hi = mid; else lo = mid + 1;
  }
  return lo;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getLogsChunked(topic, fromBlock, toBlock) {
  const out = [];
  for (let start = fromBlock; start <= toBlock; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, toBlock);
    for (let attempt = 0; ; attempt++) {
      try {
        // eslint-disable-next-line no-await-in-loop
        out.push(...await provider.getLogs({ address: POOL, topics: [topic], fromBlock: start, toBlock: end }));
        break;
      } catch (error) {
        const msg = String(error?.error?.message || error?.info?.responseBody || error?.message);
        if (attempt >= 5 || !/limit reached|rate|429|-32011/i.test(msg)) throw error;
        // eslint-disable-next-line no-await-in-loop
        await sleep(1500 * (attempt + 1)); // back off through the RPC request limit
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(100); // stay under the public endpoint rate
  }
  return out;
}

function loadState() {
  try {
    const state = JSON.parse(readFileSync(STATE, "utf8"));
    if (Number.isFinite(state?.indexedBlock) && Array.isArray(state.addLogs) && Array.isArray(state.swapLogs)) return state;
  } catch { /* first run */ }
  return null;
}

const rawLog = (log) => ({ blockNumber: log.blockNumber, topics: log.topics, data: log.data });
const mergeUnique = (older, newer) => {
  const seen = new Set(older.map((log) => `${log.blockNumber}:${log.topics[1]}:${log.data}`));
  const out = [...older];
  for (const log of newer) {
    const key = `${log.blockNumber}:${log.topics[1]}:${log.data}`;
    if (!seen.has(key)) { seen.add(key); out.push(log); }
  }
  return out.sort((a, b) => a.blockNumber - b.blockNumber);
};

async function main() {
  const pool = new Contract(POOL, abi, provider);
  const tip = await provider.getBlockNumber();
  const [reserveUsdc, reserveEurc, totalSupply, protocolUsdc, protocolEurc] = await Promise.all([
    pool.reserveUsdc(), pool.reserveEurc(), pool.totalSupply(), pool.protocolUsdc(), pool.protocolEurc(),
  ]);

  const state = loadState();
  const deployBlock = state ? undefined : process.env.FX_DEPLOY_BLOCK ? Number(process.env.FX_DEPLOY_BLOCK) : await findDeployBlock(tip);
  const checkpoint = state ? state.indexedBlock + 1 : deployBlock;
  const from = Math.max(checkpoint, tip - MAX_CATCHUP);

  const [freshAdd, freshSwap] = from <= tip
    ? await Promise.all([getLogsChunked(ADDED, from, tip), getLogsChunked(SWAPPED, from, tip)])
    : [[], []];
  const addLogs = mergeUnique(state?.addLogs || [], freshAdd.map(rawLog));
  const swapLogs = mergeUnique(state?.swapLogs || [], freshSwap.map(rawLog));

  const providers = new Set(addLogs.map((l) => ("0x" + l.topics[1].slice(26)).toLowerCase()));

  // Timestamps only for the blocks we actually need (few on a testnet).
  const blocks = [...new Set(swapLogs.map((l) => l.blockNumber))];
  const tsByBlock = new Map();
  for (const bn of blocks) {
    // eslint-disable-next-line no-await-in-loop
    const b = await provider.getBlock(bn);
    tsByBlock.set(bn, Number(b?.timestamp || 0));
  }
  const now = Math.floor(Date.now() / 1000);
  const weekAgo = now - 7 * 86400;

  let volumeUsd = 0, volume7dUsd = 0;
  for (const log of swapLogs) {
    const [, amountIn] = coder.decode(["bool", "uint256", "uint256", "uint256"], log.data);
    const v = usd(amountIn);
    volumeUsd += v;
    if ((tsByBlock.get(log.blockNumber) || 0) >= weekAgo) volume7dUsd += v;
  }

  const LP_FEE = 0.0008; // 8 bps to LPs
  const tvlUsd = usd(reserveUsdc) + usd(reserveEurc);
  const lpFeesLifetimeUsd = volumeUsd * LP_FEE;
  const lpFees7dUsd = volume7dUsd * LP_FEE;
  // APR: annualize the realized 7-day LP fee yield on current TVL.
  const aprPct = tvlUsd > 0 ? (lpFees7dUsd / tvlUsd) * (365 / 7) * 100 : 0;

  const out = {
    updatedAt: new Date().toISOString(),
    pool: POOL,
    reserveUsdc: reserveUsdc.toString(),
    reserveEurc: reserveEurc.toString(),
    totalSupply: totalSupply.toString(),
    rate: Number(reserveEurc) > 0 && Number(reserveUsdc) > 0 ? Number(reserveEurc) / Number(reserveUsdc) : 0,
    tvlUsd,
    providers: providers.size,
    deposits: addLogs.length,
    swaps: swapLogs.length,
    volumeUsd,
    volume7dUsd,
    lpFeesLifetimeUsd,
    protocolFeesUsd: usd(protocolUsdc) + usd(protocolEurc),
    aprPct,
    deployBlock: state ? state.deployBlock : deployBlock,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  writeFileSync(STATE, JSON.stringify({ indexedBlock: tip, deployBlock: out.deployBlock, addLogs, swapLogs }));
  console.log("fx-stats written:", OUT, `(${addLogs.length} deposits, ${swapLogs.length} swaps, indexed through ${tip})`);
}

main().catch((error) => { console.error(error); process.exit(1); });

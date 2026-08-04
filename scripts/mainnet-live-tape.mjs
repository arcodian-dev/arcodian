#!/usr/bin/env node
// Arc Mainnet one-second live trade tape — mainnet's counterpart to
// live-tape.mjs (testnet). mainnet-market-index.mjs is a thorough but heavy
// full-rescan indexer that only ticks every 30s (arcodian-mainnet-index.timer),
// so both /market's embedded terminal and /terminal were capped at ~30s
// staleness for "live" trades and chart candles no matter how often the
// browser polled. This is a lightweight, dedicated scanner: it reads the
// known venue addresses out of the heavy indexer's own output (no duplicate
// discovery work) and does nothing but tail new Bought/Sold/Swap logs every
// second, so the trade tape and chart are actually live.
import { Contract, Interface, JsonRpcProvider } from "ethers";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// Same same-origin PHP proxy the rest of the mainnet stack uses — it already
// round-robins/retries across the 3 known-working Arc Mainnet RPC endpoints,
// so one provider pointed here gets that failover for free.
const RPC = process.env.ARC_MAINNET_RPC_URL || "https://arcodian.fun/api/rpc-mainnet.php";
const marketPath = process.env.MAINNET_INDEX_PATH || "/www/wwwroot/arcodian.fun/shared/data/mainnet-market-index.json";
const output = process.env.MAINNET_TAPE_OUTPUT || "/www/wwwroot/arcodian.fun/shared/data/mainnet-live-tape.json";
const USDC = "0x3600000000000000000000000000000000000000";

let provider = new JsonRpcProvider(RPC, undefined, { batchMaxCount: 1, staticNetwork: true });
function rotateProvider() {
  try { provider.destroy(); } catch {}
  provider = new JsonRpcProvider(RPC, undefined, { batchMaxCount: 1, staticNetwork: true });
}

const curveInterface = new Interface([
  "event Bought(address indexed buyer,uint256 nativeIn,uint256 tokensOut,uint256 protocolFee)",
  "event Sold(address indexed seller,uint256 tokensIn,uint256 nativeOut,uint256 protocolFee)",
]);
// Uniswap V3 pool Swap — covers both V9-graduated Arcodian launches (whose
// curve.pool() becomes the venue post-graduation) and externally discovered
// global pools. amount0/amount1 are signed from the pool's own perspective.
const poolInterface = new Interface([
  "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)",
]);
const token0Abi = ["function token0() view returns(address)"];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Venue discovery resolves token0 directly from each pool. On a cold start
// hundreds of pools may need a batched RPC read; allow that bootstrap to
// finish without rotating a healthy provider. Normal live ticks remain
// one-second cadence once the venue cache is populated.
const TICK_TIMEOUT_MS = 30_000;
const VENUE_RESOLVE_CONCURRENCY = 20;

async function resolveInBatches(items, worker) {
  const results = [];
  for (let start = 0; start < items.length; start += VENUE_RESOLVE_CONCURRENCY) {
    const batch = items.slice(start, start + VENUE_RESOLVE_CONCURRENCY);
    results.push(...await Promise.all(batch.map(worker)));
  }
  return results;
}

async function runWithTimeout(task, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      task,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`live tape tick timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// venue address(lower) -> { token, symbol, type: "curve" | "pool", quoteIs0 }
let venues = new Map();
// Caches a pool's token0() across loadVenues() calls so a graduated launch
// (whose mainnet-market-index.json record carries no token0 field) only
// costs one extra RPC call the first time it's ever seen, not every 15s.
const quoteIs0Cache = new Map();
let lastMarketLoad = 0;
let lastBlock = 0;
let trades = [];

try {
  const saved = JSON.parse(await readFile(output, "utf8"));
  lastBlock = Number(saved.block || 0);
  trades = Array.isArray(saved.trades) ? saved.trades : [];
} catch {}

async function resolveQuoteIs0(pool) {
  const key = pool.toLowerCase();
  if (quoteIs0Cache.has(key)) return quoteIs0Cache.get(key);
  try {
    const token0 = await new Contract(pool, token0Abi, provider).token0();
    const value = String(token0).toLowerCase() === USDC.toLowerCase();
    quoteIs0Cache.set(key, value);
    return value;
  } catch {
    return true; // best-effort default; a wrong guess only mislabels BUY/SELL, never crashes
  }
}

async function loadVenues() {
  const index = JSON.parse(await readFile(marketPath, "utf8"));
  const next = new Map();
  const pairLaunches = (index.launches || []).filter((launch) => launch.address && launch.pair && launch.graduated);
  const pairQuotes = await resolveInBatches(pairLaunches, (launch) => resolveQuoteIs0(launch.pair));
  for (const launch of index.launches || []) {
    if (!launch.address) continue;
    if (launch.curve) next.set(String(launch.curve).toLowerCase(), { token: launch.address, symbol: launch.symbol, type: "curve" });
    if (launch.pair && launch.graduated) {
      const quoteIs0 = pairQuotes[pairLaunches.indexOf(launch)];
      next.set(String(launch.pair).toLowerCase(), { token: launch.address, symbol: launch.symbol, type: "pool", quoteIs0 });
    }
  }
  const globalPools = (index.pools || []).filter((pool) => pool.pool);
  const globalQuotes = await resolveInBatches(globalPools, (pool) => resolveQuoteIs0(pool.pool));
  for (let index = 0; index < globalPools.length; index += 1) {
    const pool = globalPools[index];
    // Radar's catalog can contain stale or normalized token0/token1 metadata.
    // The pool contract is authoritative: trusting the catalog can swap the
    // USDC and token deltas, producing prices such as e+27 and zero amounts.
    next.set(String(pool.pool).toLowerCase(), { token: pool.address, symbol: pool.symbol, type: "pool", quoteIs0: globalQuotes[index] });
  }
  venues = next;
  // Migrate tape rows written by older versions that trusted Radar's
  // token0 metadata. For reversed pools, those rows have native/tokens
  // swapped; correct them once the pool's on-chain orientation is known.
  const reversedTokens = new Set([...venues.values()]
    .filter((venue) => venue.type === "pool" && !venue.quoteIs0)
    .map((venue) => String(venue.token).toLowerCase()));
  if (reversedTokens.size) {
    trades = trades.map((trade) => {
      if (!reversedTokens.has(String(trade.token).toLowerCase())) return trade;
      // Only migrate the signature produced by the old bug: a token-sized
      // amount was stored as native while the quote-sized amount was stored
      // as tokens. Already-correct rows must remain untouched on restart.
      const native = BigInt(trade.native || "0");
      const tokens = BigInt(trade.tokens || "0");
      return native > 1_000_000_000_000_000_000n && tokens < 1_000_000_000_000_000_000n
        ? { ...trade, native: trade.tokens, tokens: trade.native }
        : trade;
    });
  }
  lastMarketLoad = Date.now();
}

async function tick() {
  if (Date.now() - lastMarketLoad > 20_000 || !venues.size) await loadVenues();
  const latest = await provider.getBlockNumber();
  if (!lastBlock) lastBlock = Math.max(0, latest - 2_000);
  if (latest <= lastBlock || !venues.size) return;
  const logs = await provider.getLogs({ address: [...venues.keys()], fromBlock: lastBlock + 1, toBlock: latest });
  const blockNumbers = [...new Set(logs.map((log) => log.blockNumber))];
  const blockTimes = new Map(await Promise.all(blockNumbers.map(async (blockNumber) => {
    const block = await provider.getBlock(blockNumber);
    return [blockNumber, Number(block?.timestamp || 0)];
  })));
  const fresh = logs.flatMap((log) => {
    const venue = venues.get(log.address.toLowerCase());
    if (!venue) return [];
    const timestamp = blockTimes.get(log.blockNumber) || 0;
    try {
      if (venue.type === "curve") {
        const parsed = curveInterface.parseLog(log);
        if (!parsed) return [];
        if (parsed.name === "Bought") return [{ token: venue.token, symbol: venue.symbol, side: "BUY", block: log.blockNumber, tx: log.transactionHash, user: parsed.args.buyer, native: parsed.args.nativeIn.toString(), tokens: parsed.args.tokensOut.toString(), timestamp }];
        if (parsed.name === "Sold") return [{ token: venue.token, symbol: venue.symbol, side: "SELL", block: log.blockNumber, tx: log.transactionHash, user: parsed.args.seller, native: parsed.args.nativeOut.toString(), tokens: parsed.args.tokensIn.toString(), timestamp }];
        return [];
      }
      const parsed = poolInterface.parseLog(log);
      if (!parsed || parsed.name !== "Swap") return [];
      const quoteDelta = venue.quoteIs0 ? parsed.args.amount0 : parsed.args.amount1;
      const tokenDelta = venue.quoteIs0 ? parsed.args.amount1 : parsed.args.amount0;
      const inputIsQuote = quoteDelta > 0n;
      return [{
        token: venue.token, symbol: venue.symbol, side: inputIsQuote ? "BUY" : "SELL", block: log.blockNumber, tx: log.transactionHash, user: parsed.args.recipient,
        native: (quoteDelta < 0n ? -quoteDelta : quoteDelta).toString(),
        tokens: (tokenDelta < 0n ? -tokenDelta : tokenDelta).toString(),
        timestamp,
      }];
    } catch { return []; }
  });
  trades = [...trades, ...fresh]
    .filter((trade, index, all) => all.findIndex((item) => item.tx === trade.tx && item.side === trade.side) === index)
    .sort((a, b) => a.block - b.block)
    .slice(-500);
  lastBlock = latest;
  const payload = JSON.stringify({ version: 1, indexedAt: new Date().toISOString(), block: lastBlock, trades });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(`${output}.tmp`, payload, { mode: 0o644 });
  await rename(`${output}.tmp`, output);
}

while (true) {
  const started = Date.now();
  try { await runWithTimeout(tick(), TICK_TIMEOUT_MS); }
  catch (error) {
    console.error(`Mainnet live tape retry: ${error?.shortMessage || error?.message || error}`);
    rotateProvider();
  }
  await sleep(Math.max(200, 1_000 - (Date.now() - started)));
}

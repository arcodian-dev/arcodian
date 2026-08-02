#!/usr/bin/env node
// Arc Mainnet launch index — every browser tab on Market/Landing used to
// scan each coin's full Bought/Sold history itself (holders, volume, trade
// count, live tape) directly against the shared free-tier arc-rpc.stakeme.pro
// RPC. That's fine for one visitor; it's a self-inflicted DDoS once there
// are several tabs open at once, and 2026-07-31 it started drawing sustained
// HTTP 429s from the upstream — which is why holders/trades/the live tape
// started showing "temporarily offline" even though the chain itself was
// fine. This mirrors the existing testnet index-market.mjs pattern (one
// server-side scan on a timer, browsers just fetch the resulting JSON) but
// trimmed to mainnet's simpler shape: one USDC-only factory, no EURC, no
// legacy factories.
import { Contract, JsonRpcProvider } from "ethers";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const RPC = process.env.ARC_MAINNET_RPC_URL || "https://arc-rpc.stakeme.pro";
const OUTPUT = process.env.MAINNET_INDEX_OUTPUT || "/www/wwwroot/arcodian.fun/shared/data/mainnet-market-index.json";
const USDC = "0x3600000000000000000000000000000000000000";

// V8 (ArcPair v2-style AMM graduation) is retired as of 2026-08-01 — the one
// coin that used it (ARCD) is dropped from the index entirely, same as the
// frontend's Market screener. V9 (real Uniswap V3 graduation) is the only
// factory indexed now. The global screener additionally discovers standard
// V3 pools from the verified Arcodian and external V3 factories below.
const FACTORIES = [
  { address: process.env.ARC_MAINNET_FACTORY_V9 || "0x071f978A9e7b8Ea0Ad914cba0d4C2c097f327066", fromBlock: 13_190_000, kind: "v3" },
];
const V3_FACTORIES = [
  { address: process.env.ARCODIAN_V3_FACTORY || "0x886694Bc4c5aCc545669E60a6694BA6a0B22d3bd", fromBlock: 13_400_000, dex: "Arcodian DEX" },
  { address: process.env.EXTERNAL_V3_FACTORY || "0xf0db7b58379503491d857dB50AC9ece64c653918", fromBlock: Number(process.env.EXTERNAL_V3_FROM_BLOCK || 10_700_000), dex: "Uniswap V3" },
];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Same 429-aware retry/queue as the testnet indexer — the whole point of
// this script is to be the ONE well-behaved client against a rate-limited
// free RPC instead of N uncoordinated browser tabs.
const rpcQueue = [Promise.resolve()];
let rpcCursor = 0;
class ThrottledProvider extends JsonRpcProvider {
  async _send(payload) {
    const run = async () => {
      await delay(Number(process.env.INDEX_RPC_INTERVAL_MS || 150));
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try { return await super._send(payload); }
        catch (error) {
          const message = String(error?.shortMessage || error?.message || error).toLowerCase();
          if (!message.includes("request limit") && !message.includes("rate limit") && !message.includes("429")) throw error;
          await delay(750 * (attempt + 1));
        }
      }
      return super._send(payload);
    };
    const lane = rpcCursor++ % rpcQueue.length;
    const result = rpcQueue[lane].then(run, run);
    rpcQueue[lane] = result.then(() => undefined, () => undefined);
    return result;
  }
}

const provider = new ThrottledProvider(RPC, undefined, { batchMaxCount: 1, staticNetwork: true });

const factoryAbi = ["function launchCount() view returns(uint256)", "function tokenByLaunch(uint256) view returns(address)", "function curveByLaunch(uint256) view returns(address)"];
const tokenAbi = ["function name() view returns(string)", "function symbol() view returns(string)", "function imageURI() view returns(string)", "function balanceOf(address) view returns(uint256)"];
const curveAbiV2 = [
  "function realNativeReserve() view returns(uint256)",
  "function VIRTUAL_NATIVE() view returns(uint256)",
  "function graduationThreshold() view returns(uint256)",
  "function graduated() view returns(bool)",
  "function creator() view returns(address)",
  "function pair() view returns(address)",
  "event Bought(address indexed buyer,uint256 nativeIn,uint256 tokensOut,uint256 protocolFee)",
  "event Sold(address indexed seller,uint256 tokensIn,uint256 nativeOut,uint256 protocolFee)",
];
const curveAbiV3 = [
  "function realNativeReserve() view returns(uint256)",
  "function VIRTUAL_NATIVE() view returns(uint256)",
  "function graduationThreshold() view returns(uint256)",
  "function graduated() view returns(bool)",
  "function creator() view returns(address)",
  "function pool() view returns(address)",
  "event Bought(address indexed buyer,uint256 nativeIn,uint256 tokensOut,uint256 protocolFee)",
  "event Sold(address indexed seller,uint256 tokensIn,uint256 nativeOut,uint256 protocolFee)",
];
const pairAbi = ["function token0() view returns(address)", "function reserve0() view returns(uint256)", "function reserve1() view returns(uint256)", "function totalSupply() view returns(uint256)", "function balanceOf(address) view returns(uint256)", "event Swapped(address indexed trader,bool zeroForOne,uint256 amountIn,uint256 amountOut,uint256 protocolFee)"];
// Uniswap V3 pool: no simple reserve0/reserve1 (concentrated liquidity), so
// token balances held by the pool stand in as a display-only reserve proxy.
// amount0/amount1 are signed: negative means the pool paid that token out.
const poolAbiV3 = ["function token0() view returns(address)", "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)"];
const poolCreatedInterface = new Contract("0x0000000000000000000000000000000000000001", ["event PoolCreated(address indexed token0,address indexed token1,uint24 indexed fee,int24 tickSpacing,address pool)"]).interface;
const poolCreatedTopic = poolCreatedInterface.getEvent("PoolCreated").topicHash;

let previous = null;
try { previous = JSON.parse(await readFile(OUTPUT, "utf8")); } catch {}

const latestBlock = await provider.getBlockNumber();
const previousByFactory = new Map((previous?.factories || []).map((f) => [f.address.toLowerCase(), f.indexedBlock]));

// The RPC's own limit is 100,000 blocks per eth_getLogs call (confirmed by
// probing it directly) — chunking at 5,000 meant ~48 sequential requests to
// cover one curve's full history, and a single exhausted-retry chunk
// anywhere in that sequence silently zeroed out every trade for that
// launch (the whole call throws, the caller's try/catch swallows it). Wider
// chunks cut the request count ~18x; per-chunk try/catch means one bad
// chunk loses only its own slice, not the whole launch's history.
const LOG_CHUNK_BLOCKS = 90_000;
// Some public Arc RPC gateways return 413 even for a filtered V3 log query
// when the block window is wide. Keep global venue/pool scans narrower than
// the legacy launch scan; subsequent timer runs only cover the new head.
const ADDRESS_LOG_CHUNK_BLOCKS = Number(process.env.INDEX_ADDRESS_LOG_CHUNK_BLOCKS || 10_000);
async function contractLogs(contract, fromBlock) {
  if (fromBlock > latestBlock) return [];
  const address = await contract.getAddress();
  const logs = [];
  for (let start = fromBlock; start <= latestBlock; start += LOG_CHUNK_BLOCKS) {
    const toBlock = Math.min(latestBlock, start + LOG_CHUNK_BLOCKS - 1);
    try {
      logs.push(...await provider.getLogs({ address, fromBlock: start, toBlock }));
    } catch (error) {
      console.error(`getLogs failed for ${address} [${start}-${toBlock}]: ${error?.shortMessage || error?.message || error}`);
    }
  }
  return logs;
}

async function addressLogs(address, fromBlock, topics) {
  if (fromBlock > latestBlock) return [];
  const logs = [];
  let complete = true;
  for (let start = fromBlock; start <= latestBlock; start += ADDRESS_LOG_CHUNK_BLOCKS) {
    const toBlock = Math.min(latestBlock, start + ADDRESS_LOG_CHUNK_BLOCKS - 1);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try { logs.push(...await provider.getLogs({ address, topics, fromBlock: start, toBlock })); break; }
      catch (error) {
        const message = String(error?.shortMessage || error?.message || error).toLowerCase();
        if (attempt === 3 || (!message.includes("413") && !message.includes("502") && !message.includes("503") && !message.includes("429") && !message.includes("rate limit"))) {
          console.error(`getLogs failed for ${address} [${start}-${toBlock}]: ${error?.shortMessage || error?.message || error}`);
          complete = false;
          break;
        }
        await delay(500 * (attempt + 1));
      }
    }
  }
  return { logs, complete };
}

const cachedByAddress = new Map((previous?.launches || []).map((item) => [item.address.toLowerCase(), item]));

const perFactory = await Promise.all(FACTORIES.map(async ({ address: FACTORY, fromBlock: deployBlock, kind }) => {
  const fromBlock = previousByFactory.has(FACTORY.toLowerCase())
    ? Math.max(0, Number(previousByFactory.get(FACTORY.toLowerCase())) + 1)
    : deployBlock;
  const factory = new Contract(FACTORY, factoryAbi, provider);
  const count = Number(await factory.launchCount());
  const seeds = await Promise.all(Array.from({ length: count }, async (_, offset) => {
    const id = offset + 1;
    const [address, curve] = await Promise.all([factory.tokenByLaunch(id), factory.curveByLaunch(id)]);
    return { address, curve, previousMarket: cachedByAddress.get(address.toLowerCase()) || null };
  }));
  const launches = await indexLaunches(seeds, { FACTORY, kind, fromBlock });
  return { address: FACTORY, kind, indexedBlock: latestBlock, launches };
}));

async function indexGlobalV3Pools() {
  const previousPools = new Map((previous?.pools || []).map((pool) => [pool.pool.toLowerCase(), pool]));
  const results = [...previousPools.values()];
  const venueCursors = new Map();
  const swapTopic = new Contract("0x0000000000000000000000000000000000000001", poolAbiV3).interface.getEvent("Swap").topicHash;
  for (const venue of V3_FACTORIES) {
    const previousVenue = previous?.venues?.find((item) => item.address.toLowerCase() === venue.address.toLowerCase());
    // Do not advance the venue cursor after a bootstrap run that found no
    // pools (for example a gateway 413/502 during the historical scan). Keep
    // retrying the historical window until at least one priced pool is
    // persisted, otherwise a transient RPC failure would permanently hide
    // the global venue from the screener.
    const forceRescan = process.env.MAINNET_GLOBAL_RESCAN === "1";
    const fromBlock = !forceRescan && previousVenue && (previous?.pools || []).length > 0
      ? Number(previousVenue.indexedBlock) + 1
      : venue.fromBlock;
    const createdResult = await addressLogs(venue.address, fromBlock, [poolCreatedTopic]);
    const created = Array.isArray(createdResult) ? createdResult : createdResult.logs;
    for (const log of created) {
      try {
        const parsed = poolCreatedInterface.parseLog(log);
        const token0 = parsed.args.token0;
        const token1 = parsed.args.token1;
        const quoteIs0 = token0.toLowerCase() === USDC.toLowerCase();
        const quoteIs1 = token1.toLowerCase() === USDC.toLowerCase();
        if (!quoteIs0 && !quoteIs1) continue;
        const tokenAddress = quoteIs0 ? token1 : token0;
        const pool = parsed.args.pool;
        const token = new Contract(tokenAddress, tokenAbi, provider);
        const poolContract = new Contract(pool, poolAbiV3, provider);
        let name = "", symbol = "", image = "";
        try { [name, symbol] = await Promise.all([token.name(), token.symbol()]); } catch {}
        try { image = await token.imageURI(); } catch {}
        const [tokenBalance, usdcBalance] = await Promise.all([
          token.balanceOf(pool),
          new Contract(USDC, tokenAbi, provider).balanceOf(pool),
        ]);
        const swapResult = await addressLogs(pool, log.blockNumber, [swapTopic]);
        const swaps = (Array.isArray(swapResult) ? swapResult : swapResult.logs).flatMap((entry) => {
          try {
            const item = poolContract.interface.parseLog(entry);
            if (item?.name !== "Swap") return [];
            const quoteDelta = quoteIs0 ? item.args.amount0 : item.args.amount1;
            const tokenDelta = quoteIs0 ? item.args.amount1 : item.args.amount0;
            const inputIsQuote = quoteDelta > 0n;
            return [{ side: inputIsQuote ? "BUY" : "SELL", block: entry.blockNumber, tx: entry.transactionHash, user: item.args.recipient, native: (quoteDelta < 0n ? -quoteDelta : quoteDelta).toString(), tokens: (tokenDelta < 0n ? -tokenDelta : tokenDelta).toString(), venue: venue.dex }];
          } catch { return []; }
        });
        const previousPool = previousPools.get(pool.toLowerCase());
        const merged = [...(previousPool?.trades || []), ...swaps]
          .filter((trade, index, all) => all.findIndex((candidate) => candidate.tx === trade.tx) === index)
          .sort((a, b) => a.block - b.block).slice(-1000);
        const timestamps = new Map();
        await Promise.all([...new Set(merged.map((trade) => trade.block))].map(async (block) => { const item = await provider.getBlock(block); timestamps.set(block, Number(item?.timestamp || 0)); }));
        const trades = merged.map((trade) => ({ ...trade, timestamp: trade.timestamp || timestamps.get(trade.block) || 0 }));
        const now = Math.floor(Date.now() / 1000);
        const volumeFor = (seconds) => trades.filter((trade) => trade.timestamp >= now - seconds).reduce((sum, trade) => sum + BigInt(trade.native), 0n);
        const priced = trades.filter((trade) => BigInt(trade.tokens) > 0n);
        const last = priced.at(-1);
        const changeFor = (seconds) => {
          const first = priced.find((trade) => trade.timestamp >= now - seconds);
          if (!first || !last) return 0;
          return (Number(BigInt(last.native)) / Number(BigInt(last.tokens))) / (Number(BigInt(first.native)) / Number(BigInt(first.tokens))) * 100 - 100;
        };
        const row = {
          address: tokenAddress, pool, curve: "", pair: pool, globalPool: true, dex: venue.dex, venue: venue.dex,
          feeTier: Number(parsed.args.fee), token0, token1, quoteKind: 0, currency: "USDC", name, symbol, image, creator: "",
          reserve: usdcBalance.toString(), virtualReserve: "0", threshold: "1", inventory: tokenBalance.toString(), graduated: true,
          factory: venue.address, tradeCount: trades.length, holderCount: new Set(trades.map((trade) => trade.user.toLowerCase())).size,
          volume: trades.reduce((sum, trade) => sum + BigInt(trade.native), 0n).toString(), volume5m: volumeFor(300).toString(), volume10m: volumeFor(600).toString(), volume1h: volumeFor(3600).toString(), volume24h: volumeFor(86400).toString(),
          priceChange5m: changeFor(300), priceChange10m: changeFor(600), priceChange1h: changeFor(3600), priceChange24h: changeFor(86400),
          marketCap: last && tokenBalance > 0n ? ((BigInt(last.native) * tokenBalance) / BigInt(last.tokens)).toString() : "0",
          liquidity: (usdcBalance * 2n).toString(), createdAt: log.blockNumber, indexedBlock: latestBlock, progress: 100, risk: venue.dex, type: "Graduated", trades,
        };
        const index = results.findIndex((item) => item.pool.toLowerCase() === pool.toLowerCase());
        if (index >= 0) results[index] = row; else results.push(row);
      } catch (error) { console.error(`Pool decode failed: ${error?.message || error}`); }
    }
    // Never advance a venue cursor past a failed historical chunk. The next
    // run must retry the missing range, otherwise one transient RPC 502/429
    // permanently hides pools such as Architects from the screener.
    const complete = Array.isArray(createdResult) ? true : createdResult.complete;
    venueCursors.set(venue.address.toLowerCase(), {
      address: venue.address,
      dex: venue.dex,
      indexedBlock: complete ? latestBlock : Math.max(0, fromBlock - 1),
    });
  }
  return { pools: results, cursors: venueCursors };
}

async function indexRadarGlobalTokens(existingPools) {
  const endpoint = process.env.RADAR_INDEX_URL || "https://web-production-efe27.up.railway.app/tokens?sort=volume24&dir=desc&limit=500&window=24h";
  const previousRadar = new Map((previous?.launches || []).filter((item) => item.radarIndexed).map((item) => [item.address.toLowerCase(), item]));
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const response = await fetch(endpoint, { signal: controller.signal, headers: { accept: "application/json" } });
    clearTimeout(timeout);
    if (!response.ok) throw new Error(`Radar index HTTP ${response.status}`);
    const body = await response.json();
    const known = new Set(existingPools.map((item) => item.address.toLowerCase()));
    return (body.tokens || []).filter((item) => item.address && !known.has(item.address.toLowerCase())).map((item) => {
      const versions = Array.isArray(item.versions) ? item.versions : [];
      const venue = versions.length ? versions.map((version) => `Uniswap ${String(version).toUpperCase()}`).join(" + ") : "Other";
      const quoteUnits = (value) => Math.max(0, Math.round(Number(value || 0) * 1_000_000)).toString();
      const pools = Array.isArray(item.pools) ? item.pools : [];
      const bestPool = pools.find((pool) => Number(pool.volume24 || 0) > 0) || pools[0] || {};
      const old = previousRadar.get(item.address.toLowerCase());
      return {
        ...(old || {}),
        address: item.address, pool: bestPool.pool || old?.pool || "", pair: bestPool.pool || old?.pair || "", globalPool: true, radarIndexed: true,
        dex: venue, venue, feeTier: Number(bestPool.feeTier || 0), token0: item.hasUsdc ? USDC : "", token1: item.address, quoteKind: 0, currency: "USDC",
        name: item.name || item.symbol || "Unknown", symbol: item.symbol || "—", image: item.icon || old?.image || "", creator: item.deployer || "",
        reserve: quoteUnits(item.liquidityUsdc / 2), virtualReserve: "0", threshold: "1", inventory: "0", graduated: true,
        factory: "radar-index", tradeCount: Number(item.txns24 || 0), holderCount: Number(item.traders24 || 0),
        volume: quoteUnits(item.volumeAll), volume5m: quoteUnits(item.volume5m), volume10m: quoteUnits(item.volume10m), volume1h: quoteUnits(item.volume1h), volume24h: quoteUnits(item.volume24),
        priceChange5m: item.change5m, priceChange10m: item.change10m, priceChange1h: item.change1h, priceChange24h: item.change24h,
        marketCap: quoteUnits(item.mcap), liquidity: quoteUnits(item.liquidityUsdc), price: Number(item.price || 0), createdAt: Number(item.firstSeen || 0), indexedBlock: latestBlock,
        progress: 100, risk: venue, type: "Global", trades: old?.trades || [], radarVersions: versions,
      };
    });
  } catch (error) {
    console.error(`Radar global index unavailable: ${error?.message || error}`);
    return [...previousRadar.values()];
  }
}

async function indexLaunches(seeds, { FACTORY, kind, fromBlock }) {
const curveAbi = kind === "v3" ? curveAbiV3 : curveAbiV2;
return Promise.all(seeds.map(async ({ address, curve, previousMarket }) => {
  const token = new Contract(address, tokenAbi, provider);
  const market = new Contract(curve, curveAbi, provider);
  let name, symbol, reserve, virtualReserve, threshold, graduated;
  let inventory;
  if (previousMarket) {
    name = previousMarket.name; symbol = previousMarket.symbol;
    virtualReserve = BigInt(previousMarket.virtualReserve); threshold = BigInt(previousMarket.threshold);
    [reserve, graduated, inventory] = await Promise.all([market.realNativeReserve(), market.graduated(), token.balanceOf(curve)]);
  } else {
    [name, symbol, reserve, virtualReserve, threshold, graduated, inventory] = await Promise.all([token.name(), token.symbol(), market.realNativeReserve(), market.VIRTUAL_NATIVE(), market.graduationThreshold(), market.graduated(), token.balanceOf(curve)]);
  }
  let pair = previousMarket?.pair || "", lpSupply = BigInt(previousMarket?.lpSupply || 0), lpBurned = BigInt(previousMarket?.lpBurned || 0);
  let dexPair = null, dexPoolV3 = null;
  if (graduated && kind === "v2") try {
    pair = await market.pair();
    dexPair = new Contract(pair, pairAbi, provider);
    const [token0, reserve0, reserve1, supply, burned] = await Promise.all([
      dexPair.token0(), dexPair.reserve0(), dexPair.reserve1(), dexPair.totalSupply(),
      dexPair.balanceOf("0x000000000000000000000000000000000000dEaD"),
    ]);
    const quoteIsToken0 = token0.toLowerCase() === USDC.toLowerCase();
    reserve = quoteIsToken0 ? reserve0 : reserve1;
    inventory = quoteIsToken0 ? reserve1 : reserve0;
    lpSupply = supply; lpBurned = burned;
  } catch {}
  // V3 pools have no simple reserve0/reserve1 (concentrated liquidity, LP
  // held as a locked NFT position rather than fungible LP tokens) — the
  // pool's own token balances stand in as a display-only reserve proxy.
  if (graduated && kind === "v3") try {
    pair = await market.pool();
    dexPoolV3 = new Contract(pair, poolAbiV3, provider);
    const token0 = await dexPoolV3.token0();
    const quoteIsToken0 = token0.toLowerCase() === USDC.toLowerCase();
    const [tokenBal, usdcBal] = await Promise.all([token.balanceOf(pair), new Contract(USDC, tokenAbi, provider).balanceOf(pair)]);
    reserve = usdcBal; inventory = tokenBal;
    void quoteIsToken0;
  } catch {}
  let image = previousMarket?.image || "", creator = previousMarket?.creator || "";
  if (!previousMarket) {
    try { image = await token.imageURI(); } catch {}
    try { creator = await market.creator(); } catch {}
  }
  let trades = [];
  try {
    trades = (await contractLogs(market, fromBlock)).flatMap((log) => {
      try {
        const parsed = market.interface.parseLog(log);
        if (parsed?.name === "Bought") return [{ side: "BUY", block: log.blockNumber, tx: log.transactionHash, user: parsed.args.buyer, native: parsed.args.nativeIn.toString(), tokens: parsed.args.tokensOut.toString() }];
        if (parsed?.name === "Sold") return [{ side: "SELL", block: log.blockNumber, tx: log.transactionHash, user: parsed.args.seller, native: parsed.args.nativeOut.toString(), tokens: parsed.args.tokensIn.toString() }];
      } catch {}
      return [];
    });
    if (dexPair) {
      const pairToken0 = (await dexPair.token0()).toLowerCase();
      const quoteIsToken0 = pairToken0 === USDC.toLowerCase();
      const swaps = (await contractLogs(dexPair, fromBlock)).flatMap((log) => {
        try {
          const parsed = dexPair.interface.parseLog(log);
          if (parsed?.name !== "Swapped") return [];
          const inputIsQuote = Boolean(parsed.args.zeroForOne) === quoteIsToken0;
          return [{
            side: inputIsQuote ? "BUY" : "SELL", block: log.blockNumber, tx: log.transactionHash, user: parsed.args.trader,
            native: (inputIsQuote ? parsed.args.amountIn : parsed.args.amountOut).toString(),
            tokens: (inputIsQuote ? parsed.args.amountOut : parsed.args.amountIn).toString(),
            venue: "DEX",
          }];
        } catch { return []; }
      });
      trades.push(...swaps);
    }
    if (dexPoolV3) {
      const poolToken0 = (await dexPoolV3.token0()).toLowerCase();
      const quoteIsToken0 = poolToken0 === USDC.toLowerCase();
      const swaps = (await contractLogs(dexPoolV3, fromBlock)).flatMap((log) => {
        try {
          const parsed = dexPoolV3.interface.parseLog(log);
          if (parsed?.name !== "Swap") return [];
          // amount0/amount1 are signed from the pool's perspective: positive
          // means the pool received that token, negative means it paid it out.
          const quoteDelta = quoteIsToken0 ? parsed.args.amount0 : parsed.args.amount1;
          const tokenDelta = quoteIsToken0 ? parsed.args.amount1 : parsed.args.amount0;
          const inputIsQuote = quoteDelta > 0n;
          return [{
            side: inputIsQuote ? "BUY" : "SELL", block: log.blockNumber, tx: log.transactionHash, user: parsed.args.recipient,
            native: (quoteDelta < 0n ? -quoteDelta : quoteDelta).toString(),
            tokens: (tokenDelta < 0n ? -tokenDelta : tokenDelta).toString(),
            venue: "DEX",
          }];
        } catch { return []; }
      });
      trades.push(...swaps);
    }
    trades.sort((a, b) => a.block - b.block);
    const timestamps = new Map();
    await Promise.all([...new Set(trades.map((trade) => trade.block))].map(async (blockNumber) => {
      const block = await provider.getBlock(blockNumber);
      timestamps.set(blockNumber, Number(block?.timestamp || 0));
    }));
    trades = trades.map((trade) => ({ ...trade, timestamp: timestamps.get(trade.block) || 0 }));
  } catch {}
  trades = [...(previousMarket?.trades || []), ...trades]
    .filter((trade, index, all) => all.findIndex((candidate) => candidate.tx === trade.tx && candidate.side === trade.side) === index)
    .sort((a, b) => a.block - b.block)
    .slice(-1000);
  const volume = trades.reduce((sum, trade) => sum + BigInt(trade.native), 0n);
  const now = Math.floor(Date.now() / 1000);
  const volume24h = trades.filter((trade) => trade.timestamp >= now - 86400).reduce((sum, trade) => sum + BigInt(trade.native), 0n);
  const holderCount = new Set(trades.map((trade) => trade.user.toLowerCase())).size;
  const pricedTrades = trades.filter((trade) => BigInt(trade.tokens) > 0n);
  const first24h = pricedTrades.find((trade) => trade.timestamp >= now - 86400);
  const lastTrade = pricedTrades.at(-1);
  const priceChange24h = first24h && lastTrade
    ? (Number(BigInt(lastTrade.native)) / Number(BigInt(lastTrade.tokens))) / (Number(BigInt(first24h.native)) / Number(BigInt(first24h.tokens))) * 100 - 100
    : 0;
  return {
    address, curve, pair, quoteKind: 0, currency: "USDC",
    lpSupply: lpSupply.toString(), lpBurned: lpBurned.toString(),
    name, symbol, image, creator,
    reserve: reserve.toString(), virtualReserve: virtualReserve.toString(), threshold: threshold.toString(), inventory: inventory.toString(),
    graduated, factory: FACTORY,
    tradeCount: trades.length, holderCount,
    volume: volume.toString(), volume24h: volume24h.toString(), priceChange24h,
    createdAt: trades[0]?.timestamp || 0,
    trades: trades.slice(-200),
  };
}));
}

const globalResult = await indexGlobalV3Pools();
const radarPools = await indexRadarGlobalTokens(globalResult.pools);
const globalPools = [...globalResult.pools, ...radarPools];
const launchesOut = [...perFactory.flatMap((f) => f.launches), ...globalPools].reverse();
const recentTrades = launchesOut.flatMap((launch) => launch.trades.slice(-20).map((trade) => ({ ...trade, token: launch.address, symbol: launch.symbol }))).sort((a, b) => b.block - a.block).slice(0, 60);

const payload = {
  version: 1, chainId: 5042,
  factory: FACTORIES[0].address, // legacy field, kept for older cached clients
  factories: perFactory.map(({ address, kind, indexedBlock }) => ({ address, kind, indexedBlock })),
  venues: V3_FACTORIES.map(({ address, dex }) => globalResult.cursors.get(address.toLowerCase()) || ({ address, dex, indexedBlock: latestBlock })),
  pools: globalPools,
  indexedAt: new Date().toISOString(), indexedBlock: latestBlock, launches: launchesOut, recentTrades,
};
await mkdir(dirname(OUTPUT), { recursive: true });
await writeFile(`${OUTPUT}.tmp`, JSON.stringify(payload), { mode: 0o644 });
await rename(`${OUTPUT}.tmp`, OUTPUT);
console.log(`Mainnet market index written: ${launchesOut.length} launches, block ${latestBlock}`);
await provider.destroy();

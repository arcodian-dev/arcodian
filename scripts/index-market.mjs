import { Contract, JsonRpcProvider } from "ethers";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const rpc = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network/";
const output = process.env.INDEX_OUTPUT || new URL("../public/data/market-index.json", import.meta.url).pathname;
// Canonical v10 factories only. Retired deployments remain readable on-chain,
// but must never leak back into the public market index after a stack reset.
const factories = (process.env.PUMP_FACTORIES ||
  [
    "0x453a38aB960137e0294665d7C5A1BC0B1C41b9cc@10", // canonical USDC v10
    "0x171033cA9A61C71A73e0f68FfA3BEEFFEA44f2ef@10", // canonical EURC v10
  ].join(","))
  .split(",")
  .filter(Boolean)
  .map((entry) => {
    const [address, version] = entry.trim().split("@");
    return { address, configuredVersion: version ? Number(version) : null };
  });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rpcQueues = [Promise.resolve()];
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
    const lane = rpcCursor++ % rpcQueues.length;
    const result = rpcQueues[lane].then(run, run);
    rpcQueues[lane] = result.then(() => undefined, () => undefined);
    return result;
  }
}
const provider = new ThrottledProvider(rpc, undefined, { batchMaxCount: 1, staticNetwork: true });
const CANONICAL_V9_DEPLOY_BLOCK = Number(process.env.CANONICAL_V9_DEPLOY_BLOCK || 53_006_971);
const USDC = "0x3600000000000000000000000000000000000000";
const EURC = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";
const PAIR_QUOTE_SCALE = 10n ** 12n; // ArcPair stablecoin reserves are 6-decimal.
const factoryAbi = ["function launchCount() view returns(uint256)", "function tokenByLaunch(uint256) view returns(address)", "function curveByLaunch(uint256) view returns(address)", "function ENGINE_VERSION() view returns(uint8)", "function QUOTE_KIND() view returns(uint8)"];
const tokenAbi = ["function name() view returns(string)", "function symbol() view returns(string)", "function imageURI() view returns(string)", "function balanceOf(address) view returns(uint256)"];
// EURC (quoteKind 1) curves/pairs expose realQuoteReserve/VIRTUAL_QUOTE/quoteReserve
// instead of the native USDC names; events share the same topic hashes (only param
// names differ), so a single ABI parses both. EURC collateral is 6-dec and is
// normalized to 18-dec (x1e12) below so every downstream consumer stays unchanged.
const curveAbi = ["function realNativeReserve() view returns(uint256)", "function realQuoteReserve() view returns(uint256)", "function VIRTUAL_NATIVE() view returns(uint256)", "function VIRTUAL_QUOTE() view returns(uint256)", "function graduationThreshold() view returns(uint256)", "function graduated() view returns(bool)", "function creator() view returns(address)", "function pair() view returns(address)", "event Bought(address indexed buyer,uint256 nativeIn,uint256 tokensOut,uint256 protocolFee)", "event Sold(address indexed seller,uint256 tokensIn,uint256 nativeOut,uint256 protocolFee)"];
const pairAbi = ["function token0() view returns(address)","function token1() view returns(address)","function reserve0() view returns(uint256)","function reserve1() view returns(uint256)","function totalSupply() view returns(uint256)","function balanceOf(address) view returns(uint256)","event Swapped(address indexed trader,bool zeroForOne,uint256 amountIn,uint256 amountOut,uint256 protocolFee)"];
let previous = null;
try { previous = JSON.parse(await readFile(output, "utf8")); } catch {}
const latestBlock = await provider.getBlockNumber();
// Version 7 is the first index with canonical-v9 historical curve + ArcPair
// event coverage. Older payloads must backfill once from the deployment block.
const fromBlock = previous?.version >= 7 && previous?.indexedBlock
  ? Math.max(0, Number(previous.indexedBlock) + 1)
  : CANONICAL_V9_DEPLOY_BLOCK;
async function marketLogs(market) {
  if (fromBlock > latestBlock) return [];
  const logs = [];
  for (let start = fromBlock; start <= latestBlock; start += 10000) {
    logs.push(...await provider.getLogs({ address: await market.getAddress(), fromBlock: start, toBlock: Math.min(latestBlock, start + 9999) }));
  }
  return logs;
}

const groups = await Promise.all(factories.map(async ({ address: factoryAddress, configuredVersion }) => {
  const factory = new Contract(factoryAddress, factoryAbi, provider);
  let engineVersion = configuredVersion;
  if (!engineVersion) {
    try { engineVersion = Number(await factory.ENGINE_VERSION()); }
    catch { engineVersion = 5; }
  }
  let quoteKind = 0;
  try { quoteKind = Number(await factory.QUOTE_KIND()); } catch {}
  const SCALE = quoteKind === 1 ? 10n ** 12n : 1n; // EURC 6-dec -> 18-dec
  const rFn = quoteKind === 1 ? "realQuoteReserve" : "realNativeReserve";
  const vFn = quoteKind === 1 ? "VIRTUAL_QUOTE" : "VIRTUAL_NATIVE";
  const currency = quoteKind === 1 ? "EURC" : "USDC";
  const quoteAddress = (quoteKind === 1 ? EURC : USDC).toLowerCase();
  const cachedMarkets = previous?.indexedBlock
    ? (previous.launches || []).filter((item) => item.factory.toLowerCase() === factoryAddress.toLowerCase())
    : [];
  // Always ask the factory what exists. The cache is for skipping trade
  // history already scanned, never for deciding which markets exist: seeding
  // from the previous file alone meant a factory that already had one indexed
  // launch never had its launchCount read again, so every coin launched after
  // the first was invisible on the site forever.
  const cachedByAddress = new Map(cachedMarkets.map((item) => [item.address.toLowerCase(), item]));
  const count = Number(await factory.launchCount());
  const seeds = await Promise.all(Array.from({ length: count }, async (_, offset) => {
    const id = offset + 1;
    const [address, curve] = await Promise.all([factory.tokenByLaunch(id), factory.curveByLaunch(id)]);
    return { address, curve, previousMarket: cachedByAddress.get(address.toLowerCase()) || null };
  }));
  return Promise.all(seeds.map(async ({ address, curve, previousMarket }) => {
    const token = new Contract(address, tokenAbi, provider);
    const market = new Contract(curve, curveAbi, provider);
    let name, symbol, reserve, virtualReserve, threshold, graduated, inventory;
    if (previousMarket) {
      name = previousMarket.name; symbol = previousMarket.symbol;
      virtualReserve = BigInt(previousMarket.virtualReserve); threshold = BigInt(previousMarket.threshold);
      [reserve, graduated, inventory] = await Promise.all([market[rFn](), market.graduated(), token.balanceOf(curve)]);
      reserve *= SCALE;
    } else {
      [name, symbol, reserve, virtualReserve, threshold, graduated, inventory] = await Promise.all([token.name(), token.symbol(), market[rFn](), market[vFn](), market.graduationThreshold(), market.graduated(), token.balanceOf(curve)]);
      reserve *= SCALE; virtualReserve *= SCALE; threshold *= SCALE;
    }
    let pair = previousMarket?.pair || "", lpSupply = BigInt(previousMarket?.lpSupply || 0), lpBurned = BigInt(previousMarket?.lpBurned || 0);
    let dexPair = null;
    if (graduated) try {
      pair = await market.pair();
      dexPair = new Contract(pair, pairAbi, provider);
      const [token0, reserve0, reserve1, supply, burned] = await Promise.all([
        dexPair.token0(), dexPair.reserve0(), dexPair.reserve1(), dexPair.totalSupply(),
        dexPair.balanceOf("0x000000000000000000000000000000000000dEaD"),
      ]);
      const quoteIsToken0 = token0.toLowerCase() === quoteAddress;
      reserve = (quoteIsToken0 ? reserve0 : reserve1) * PAIR_QUOTE_SCALE;
      inventory = quoteIsToken0 ? reserve1 : reserve0;
      lpSupply = supply;
      lpBurned = burned;
    } catch {}
    let image = previousMarket?.image || "", creator = previousMarket?.creator || "";
    if (!previousMarket) {
      try { image = await token.imageURI(); } catch {}
      try { creator = await market.creator(); } catch {}
    }
    let trades = [];
    try {
      trades = (await marketLogs(market)).flatMap((log) => {
        try {
          const parsed = market.interface.parseLog(log);
          if (parsed?.name === "Bought") return [{ side: "BUY", block: log.blockNumber, tx: log.transactionHash, user: parsed.args.buyer, native: (parsed.args.nativeIn * SCALE).toString(), tokens: parsed.args.tokensOut.toString() }];
          if (parsed?.name === "Sold") return [{ side: "SELL", block: log.blockNumber, tx: log.transactionHash, user: parsed.args.seller, native: (parsed.args.nativeOut * SCALE).toString(), tokens: parsed.args.tokensIn.toString() }];
        } catch {}
        return [];
      }).sort((a, b) => a.block - b.block);
      if (dexPair) {
        const swaps = (await marketLogs(dexPair)).flatMap((log) => {
          try {
            const parsed = dexPair.interface.parseLog(log);
            if (parsed?.name === "Swapped") return [{ parsed, log }];
          } catch {}
          return [];
        });
        const pairToken0 = (await dexPair.token0()).toLowerCase();
        const quoteIsToken0 = pairToken0 === quoteAddress;
        trades.push(...swaps.map(({parsed,log}) => {
          const inputIsQuote = Boolean(parsed.args.zeroForOne) === quoteIsToken0;
          return {
            side: inputIsQuote ? "BUY" : "SELL",
            block: log.blockNumber,
            tx: log.transactionHash,
            user: parsed.args.trader,
            native: ((inputIsQuote ? parsed.args.amountIn : parsed.args.amountOut) * PAIR_QUOTE_SCALE).toString(),
            tokens: (inputIsQuote ? parsed.args.amountOut : parsed.args.amountIn).toString(),
            venue: "DEX",
          };
        }));
        trades.sort((a, b) => a.block - b.block);
      }
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
      // Keep enough canonical history for wallet profiles while the UI paginates
      // in small batches. The browser never scans RPC logs itself.
      .slice(-1000);
    const volume = trades.reduce((sum, trade) => sum + BigInt(trade.native), 0n);
    const now = Math.floor(Date.now() / 1000);
    const volume1h = trades.filter((trade) => trade.timestamp >= now - 3600).reduce((sum, trade) => sum + BigInt(trade.native), 0n);
    const volume24h = trades.filter((trade) => trade.timestamp >= now - 86400).reduce((sum, trade) => sum + BigInt(trade.native), 0n);
    const traderAddresses = [...new Set(trades.map((trade) => trade.user.toLowerCase()))];
    const balances = await Promise.all(traderAddresses.map(async (holder) => {
      try { return { address: holder, balance: await token.balanceOf(holder) }; }
      catch { return { address: holder, balance: 0n }; }
    }));
    const topHolders = balances.filter((holder) => holder.balance > 0n).sort((a, b) => a.balance > b.balance ? -1 : 1).slice(0, 10).map((holder) => ({ address: holder.address, balance: holder.balance.toString() }));
    const pricedTrades = trades.filter((trade) => BigInt(trade.tokens) > 0n);
    const first24h = pricedTrades.find((trade) => trade.timestamp >= now - 86400);
    const lastTrade = pricedTrades.at(-1);
    const priceChange24h = first24h && lastTrade
      ? (Number(BigInt(lastTrade.native)) / Number(BigInt(lastTrade.tokens))) / (Number(BigInt(first24h.native)) / Number(BigInt(first24h.tokens))) * 100 - 100
      : 0;
    return { address, curve, pair, engineVersion, quoteKind, currency, lpSupply: lpSupply.toString(), lpBurned: lpBurned.toString(), name, symbol, image, creator, reserve: reserve.toString(), virtualReserve: virtualReserve.toString(), threshold: threshold.toString(), inventory: inventory.toString(), graduated, factory: factoryAddress, tradeCount: trades.length, holderCount: topHolders.length, volume: volume.toString(), volume1h: volume1h.toString(), volume24h: volume24h.toString(), priceChange24h, topHolders, createdAt: trades[0]?.timestamp || 0, trades: trades.slice(-100) };
  }));
}));
const launches = groups.flat().reverse();
const activity = launches.flatMap((launch) => launch.trades.map((trade) => ({ ...trade, token: launch.address, symbol: launch.symbol }))).sort((a, b) => b.block - a.block).slice(0, 100);
const nowDate = new Date();
const monday = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate()));
monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
const roundId = monday.toISOString().slice(0, 10);
const standings = launches.filter((launch) => !launch.graduated).map((launch) => ({
  token: launch.address, symbol: launch.symbol, name: launch.name, image: launch.image,
  score: Number(BigInt(launch.volume24h || "0") / 10n ** 14n) + launch.tradeCount * 5 + Number(BigInt(launch.reserve) * 10000n / BigInt(launch.threshold)) / 100,
  volume24h: launch.volume24h, tradeCount: launch.tradeCount,
})).sort((a, b) => b.score - a.score);
let arenaHistory = Array.isArray(previous?.arena?.history) ? previous.arena.history : [];
if (previous?.arena?.roundId && previous.arena.roundId !== roundId && previous.arena.standings?.[0]) {
  const winner = previous.arena.standings[0];
  if (!arenaHistory.some((entry) => entry.roundId === previous.arena.roundId)) arenaHistory.unshift({ roundId: previous.arena.roundId, winner, finalizedAt: new Date().toISOString() });
}
arenaHistory = arenaHistory.slice(0, 12);
const payload = JSON.stringify({ version: 7, chainId: 5042002, engineVersion: 10, factories: factories.map(({address})=>address), indexedAt: new Date().toISOString(), indexedBlock: latestBlock, launches, activity, arena: { roundId, standings: standings.slice(0, 10), history: arenaHistory } });
await mkdir(dirname(output), { recursive: true });
await writeFile(`${output}.tmp`, payload, { mode: 0o644 });
await rename(`${output}.tmp`, output);
await provider.destroy();
console.log(`Indexed ${groups.flat().length} Arcodian markets`);

import { Interface, JsonRpcProvider } from "ethers";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const rpc = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network/";
const marketPath = process.env.INDEX_OUTPUT || "/www/wwwroot/arcodian.fun/shared/data/market-index.json";
const output = process.env.TAPE_OUTPUT || "/www/wwwroot/arcodian.fun/shared/data/live-tape.json";
const provider = new JsonRpcProvider(rpc, undefined, { batchMaxCount: 1, staticNetwork: true });
const curveInterface = new Interface([
  "event Bought(address indexed buyer,uint256 nativeIn,uint256 tokensOut,uint256 protocolFee)",
  "event Sold(address indexed seller,uint256 tokensIn,uint256 nativeOut,uint256 protocolFee)",
]);
const pairInterface = new Interface([
  "event Swap(address indexed trader,bool nativeToToken,uint256 amountIn,uint256 amountOut,uint256 protocolFee)",
]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let venues = new Map();
let lastMarketLoad = 0;
let lastBlock = 0;
let trades = [];

try {
  const saved = JSON.parse(await readFile(output, "utf8"));
  lastBlock = Number(saved.block || 0);
  trades = Array.isArray(saved.trades) ? saved.trades : [];
} catch {}

async function loadMarkets() {
  const index = JSON.parse(await readFile(marketPath, "utf8"));
  const next = new Map();
  for (const market of index.launches || []) {
    next.set(String(market.curve).toLowerCase(), { token: market.address, symbol: market.symbol, type: "curve" });
    if (market.pair) next.set(String(market.pair).toLowerCase(), { token: market.address, symbol: market.symbol, type: "pair" });
  }
  venues = next;
  lastMarketLoad = Date.now();
}

async function tick() {
  if (Date.now() - lastMarketLoad > 15_000 || !venues.size) await loadMarkets();
  const latest = await provider.getBlockNumber();
  if (!lastBlock) lastBlock = Math.max(0, latest - 5_000);
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
    try {
      const parsed = (venue.type === "pair" ? pairInterface : curveInterface).parseLog(log);
      if (!parsed) return [];
      const timestamp = blockTimes.get(log.blockNumber) || 0;
      if (parsed.name === "Bought") return [{ ...venue, side: "BUY", block: log.blockNumber, tx: log.transactionHash, user: parsed.args.buyer, native: parsed.args.nativeIn.toString(), tokens: parsed.args.tokensOut.toString(), timestamp }];
      if (parsed.name === "Sold") return [{ ...venue, side: "SELL", block: log.blockNumber, tx: log.transactionHash, user: parsed.args.seller, native: parsed.args.nativeOut.toString(), tokens: parsed.args.tokensIn.toString(), timestamp }];
      if (parsed.name === "Swap") return [{ ...venue, side: parsed.args.nativeToToken ? "BUY" : "SELL", block: log.blockNumber, tx: log.transactionHash, user: parsed.args.trader, native: (parsed.args.nativeToToken ? parsed.args.amountIn : parsed.args.amountOut).toString(), tokens: (parsed.args.nativeToToken ? parsed.args.amountOut : parsed.args.amountIn).toString(), timestamp }];
    } catch {}
    return [];
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
  try { await tick(); }
  catch (error) {
    const message = String(error?.shortMessage || error?.message || error);
    console.error(`Live tape retry: ${message}`);
  }
  await sleep(Math.max(100, 1_000 - (Date.now() - started)));
}

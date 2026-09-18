// Arcodian stock price service: the signer behind ArcSignedPriceFeed.
//
// Every few seconds during the US regular session it reads each listed stock
// from independent public quote sources (CNBC and Nasdaq in batches, Yahoo one
// symbol at a time in rotation), takes the median of the fresh ones, and signs
// it only when at least two agree within MAX_SPREAD_BPS. The signed bundle is
// written to shared/data/stock-prices.json, which /stocks fetches and passes
// into each trade, exactly as it would a Pyth update.
//
// Outside the regular session nothing is signed, so prices go stale and the
// market stops trading, the same as it would on Pyth's equity feeds.
//
// Server-only config: /root/.config/arcodian/stock-signer.json { "PRIVATE_KEY": "0x…" }
// Env: STOCK_FEED_ADDRESS (required), STOCK_PRICES_OUT, FORCE_SIGN=1 (ignore
// market hours and use extended-hours quotes; for fork testing only).
import { readFile, rename, writeFile } from "node:fs/promises";
import { AbiCoder, Wallet, getBytes, hashMessage, keccak256, toUtf8Bytes } from "ethers";

const FEED = process.env.STOCK_FEED_ADDRESS;
if (!FEED) throw new Error("STOCK_FEED_ADDRESS is required");
const CHAIN_ID = Number(process.env.STOCK_CHAIN_ID || 5042);
const OUT = process.env.STOCK_PRICES_OUT || "/www/wwwroot/arcodian.fun/shared/data/stock-prices.json";
const INTERVAL_MS = Number(process.env.STOCK_INTERVAL_MS || 10_000);
const FORCE = process.env.FORCE_SIGN === "1";
const MAX_SPREAD_BPS = 50; // sources must agree within 0.5% of the median
const MIN_CONF_BPS = 5; // confidence band floor: 0.05% of price
const EXPO = -5;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36";

// Same ids as Pyth's US equity feeds, so the market listing is unchanged.
const STOCKS = [
  ["NVDA", "0xb1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593"],
  ["AAPL", "0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688"],
  ["TSLA", "0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1"],
  ["SPY", "0x19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5"],
  ["QQQ", "0x9695e2b96ea7b3859da9ed25b7a46a920a776e2fdae19a7bcfdf2b219230452d"],
  ["MSFT", "0xd0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1"],
  ["AMZN", "0xb5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a"],
  ["GOOGL", "0x5a48c03e9b9cb337801073ed9d166817473697efff0d138874e0f6a33d6d5aa6"],
  ["META", "0x78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe"],
  ["COIN", "0xfee33f2a978bf32dd6b662b65ba8083c6773b494f8401194ec1870c640860245"],
];
const ETFS = new Set(["SPY", "QQQ"]);
const TYPEHASH = keccak256(toUtf8Bytes("ArcodianPrice(uint256 chainId,address feed,bytes32 id,int64 price,uint64 conf,int32 expo,uint64 publishTime)"));
const abi = AbiCoder.defaultAbiCoder();
const config = JSON.parse(await readFile(process.env.STOCK_SIGNER_CONFIG || "/root/.config/arcodian/stock-signer.json", "utf8"));
const wallet = new Wallet(config.PRIVATE_KEY);

export function usMarketOpen(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(now).map((p) => [p.type, p.value]));
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

async function getJson(url) {
  const response = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`${new URL(url).host} ${response.status}`);
  return response.json();
}

const num = (value) => Number(String(value).replace(/[$,]/g, ""));

/** CNBC, all symbols in one call. Regular-session price while the market is open. */
async function cnbc() {
  const symbols = STOCKS.map(([s]) => s).join("|");
  const body = await getJson(`https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${symbols}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json`);
  const out = {};
  for (const q of body.FormattedQuoteResult.FormattedQuote) {
    if (q.curmktstatus === "REG_MKT") out[q.symbol] = num(q.last);
    else if (FORCE && q.ExtendedMktQuote?.last) out[q.symbol] = num(q.ExtendedMktQuote.last);
  }
  return out;
}

/** "Sep 18, 2026 10:13 AM" in New York time → epoch ms (EDT or EST as it falls). */
export function newYorkToEpoch(text) {
  const asUtc = Date.parse(`${text} UTC`);
  if (!Number.isFinite(asUtc)) return NaN;
  const ny = new Date(new Date(asUtc).toLocaleString("en-US", { timeZone: "America/New_York" }));
  const utc = new Date(new Date(asUtc).toLocaleString("en-US", { timeZone: "UTC" }));
  return asUtc + (utc.getTime() - ny.getTime());
}

/** Nasdaq watchlist, all symbols in one call; minute-resolution timestamp. */
async function nasdaq() {
  const query = STOCKS.map(([s]) => `symbol=${s.toLowerCase()}%7C${ETFS.has(s) ? "etf" : "stocks"}`).join("&");
  const body = await getJson(`https://api.nasdaq.com/api/quote/watchlist?${query}`);
  const out = {};
  for (const q of body.data ?? []) {
    const at = newYorkToEpoch(String(q.lastTradeTimestamp).replace(/ ET$/, ""));
    if (FORCE || (Number.isFinite(at) && Date.now() - at < 3 * 60_000)) out[q.symbol] = num(q.lastSalePrice);
  }
  return out;
}

/** Yahoo rate-limits batches, so one symbol per tick, each kept 60 s. */
const yahooCache = {};
let yahooNext = 0;
async function yahooTick() {
  const [symbol] = STOCKS[yahooNext++ % STOCKS.length];
  try {
    const body = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=1d`);
    const meta = body.chart.result[0].meta;
    yahooCache[symbol] = { price: meta.regularMarketPrice, at: meta.regularMarketTime * 1000 };
  } catch { /* the other two sources carry the tick */ }
}
function yahoo() {
  const out = {};
  for (const [symbol, q] of Object.entries(yahooCache)) {
    if (FORCE || Date.now() - q.at < 90_000) out[symbol] = q.price;
  }
  return out;
}

/** Median of the fresh quotes, or null unless ≥2 agree within MAX_SPREAD_BPS. */
export function aggregate(values) {
  const quotes = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (quotes.length < 2) return null;
  const mid = quotes.length % 2 ? quotes[(quotes.length - 1) / 2] : (quotes[quotes.length / 2 - 1] + quotes[quotes.length / 2]) / 2;
  const worst = Math.max(...quotes.map((q) => Math.abs(q - mid)));
  if (worst * 10_000 > mid * MAX_SPREAD_BPS) return null;
  return { price: mid, conf: Math.max(worst, mid * MIN_CONF_BPS / 10_000), sources: quotes.length };
}

async function sign(id, price, conf, publishTime) {
  const p = BigInt(Math.round(price * 10 ** -EXPO));
  const c = BigInt(Math.max(1, Math.round(conf * 10 ** -EXPO)));
  const inner = keccak256(abi.encode(["bytes32", "uint256", "address", "bytes32", "int64", "uint64", "int32", "uint64"], [TYPEHASH, CHAIN_ID, FEED, id, p, c, EXPO, publishTime]));
  const sig = wallet.signingKey.sign(hashMessage(getBytes(inner))); // EIP-191, as ArcSignedPriceFeed.digest
  const update = abi.encode(["bytes32", "int64", "uint64", "int32", "uint64", "uint8", "bytes32", "bytes32"], [id, p, c, EXPO, publishTime, sig.v, sig.r, sig.s]);
  return { update, price: p.toString(), conf: c.toString(), expo: EXPO, publishTime };
}

async function tick() {
  const open = FORCE || usMarketOpen();
  const feeds = {};
  const skipped = {};
  if (open) {
    await yahooTick();
    const [a, b] = await Promise.allSettled([cnbc(), nasdaq()]);
    const c = yahoo();
    const publishTime = Math.floor(Date.now() / 1000);
    for (const [symbol, id] of STOCKS) {
      const values = [a.status === "fulfilled" ? a.value[symbol] : undefined, b.status === "fulfilled" ? b.value[symbol] : undefined, c[symbol]];
      const agg = aggregate(values);
      if (!agg) { skipped[symbol] = values.map((v) => v ?? null); continue; }
      feeds[id] = { symbol, sources: agg.sources, ...(await sign(id, agg.price, agg.conf, publishTime)) };
    }
  }
  const body = JSON.stringify({ ok: true, feed: FEED, signer: wallet.address, marketOpen: open, signedAt: Math.floor(Date.now() / 1000), feeds, skipped });
  await writeFile(`${OUT}.tmp`, body);
  await rename(`${OUT}.tmp`, OUT);
  return { open, signed: Object.keys(feeds).length, skipped: Object.keys(skipped) };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  let last = "";
  for (;;) {
    try {
      const result = await tick();
      const line = JSON.stringify(result);
      if (line !== last) { console.log(new Date().toISOString(), line); last = line; }
    } catch (error) { console.error(new Date().toISOString(), error instanceof Error ? error.message : error); }
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
}

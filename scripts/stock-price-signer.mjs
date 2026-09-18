// Arcodian stock price service: the signer behind ArcSignedPriceFeed.
//
// Every few seconds during the US regular session it reads each listed stock
// from two independent public quote sources (CNBC and Nasdaq, each one batch
// call for all stocks) and signs the midpoint only when both are fresh and
// within MAX_SPREAD_BPS of each other. (Yahoo was a third source until it
// began rate-limiting this server; a source that is often missing only adds
// delay.) It also keeps chart candles from CNBC for the page. The signed bundle is
// written to shared/data/stock-prices.json, which /stocks fetches and passes
// into each trade, exactly as it would a Pyth update.
//
// Outside the regular session nothing is signed, so prices go stale and the
// market stops trading, the same as it would on Pyth's equity feeds.
//
// Server-only config: /root/.config/arcodian/stock-signer.json { "PRIVATE_KEY": "0x…" }
// Env: STOCK_FEED_ADDRESS (required), STOCK_PRICES_OUT, FORCE_SIGN=1 (ignore
// market hours and use extended-hours quotes; for fork testing only).
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { AbiCoder, Wallet, getBytes, hashMessage, keccak256, toUtf8Bytes } from "ethers";

const FEED = process.env.STOCK_FEED_ADDRESS;
if (!FEED) throw new Error("STOCK_FEED_ADDRESS is required");
const CHAIN_ID = Number(process.env.STOCK_CHAIN_ID || 5042);
const OUT = process.env.STOCK_PRICES_OUT || "/www/wwwroot/arcodian.fun/shared/data/stock-prices.json";
const INTERVAL_MS = Number(process.env.STOCK_INTERVAL_MS || 5_000);
const FORCE = process.env.FORCE_SIGN === "1";
const MAX_SPREAD_BPS = 50; // highest and lowest source within 0.5% of each other
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

/** CNBC, all symbols in one call. Returns the regular-session prices used for
 * signing (only while CNBC reports the regular market) and, for display, the
 * latest quote in any session (pre-market, after-hours or the last close). */
async function cnbc() {
  const symbols = STOCKS.map(([s]) => s).join("|");
  const body = await getJson(`https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${symbols}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json`);
  const regular = {};
  const display = {};
  for (const q of body.FormattedQuoteResult.FormattedQuote) {
    const ext = q.ExtendedMktQuote;
    if (q.curmktstatus === "REG_MKT") regular[q.symbol] = num(q.last);
    else if (FORCE && ext?.last) regular[q.symbol] = num(ext.last);
    const session = q.curmktstatus === "REG_MKT" ? "regular" : ext?.type === "PRE_MKT" ? "pre-market" : ext?.type === "POST_MKT" ? "after-hours" : "closed";
    // Reference for the day's change: yesterday's close during the session,
    // the latest regular close outside it (what pre/after-hours moves from).
    const regularSession = session === "regular";
    display[q.symbol] = {
      price: num(ext?.last && !regularSession ? ext.last : q.last),
      close: num(q.last),
      reference: regularSession ? num(q.previous_day_closing) : num(q.last),
      session,
      open: num(q.open) || null, high: num(q.high) || null, low: num(q.low) || null,
      volume: String(q.volume ?? ""), marketCap: q.mktcapView ?? null, pe: q.pe ?? null,
      yearHigh: num(q.yrhiprice) || null, yearLow: num(q.yrloprice) || null, name: q.name ?? null,
    };
  }
  return { regular, display };
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

// --- chart candles (display only; never signed, never seen on-chain) -------

const CANDLES_DIR = process.env.STOCK_CANDLES_DIR || "/www/wwwroot/arcodian.fun/shared/data/stock-candles";
/** Chart ranges (CNBC's names) and how often each is refreshed. */
const RANGES = { "1D": 2 * 60_000, "5D": 10 * 60_000, "1M": 30 * 60_000, "6M": 6 * 3600_000, "1Y": 6 * 3600_000 };
const candlesFetchedAt = {};
let candlesReady = false;

async function writeCandles(symbol, range) {
  const body = await getJson(`https://ts-api.cnbc.com/harmony/app/charts/${range}.json?symbol=${symbol}`);
  const out = [];
  let lastTime = 0;
  for (const bar of body.barData?.priceBars ?? []) {
    const time = Math.floor(Number(bar.tradeTimeinMills) / 1000);
    const [open, high, low, close] = [bar.open, bar.high, bar.low, bar.close].map(Number);
    if (!(time > lastTime) || ![open, high, low, close].every((v) => Number.isFinite(v) && v > 0)) continue;
    out.push({ time, open, high, low, close, volume: Number(bar.volume) || 0 });
    lastTime = time;
  }
  if (!out.length) return;
  if (!candlesReady) { await mkdir(CANDLES_DIR, { recursive: true }); candlesReady = true; }
  const file = `${CANDLES_DIR}/${symbol}-${range}.json`;
  await writeFile(`${file}.tmp`, JSON.stringify({ symbol, range, updatedAt: Math.floor(Date.now() / 1000), candles: out }));
  await rename(`${file}.tmp`, file);
}

/** One overdue (symbol, range) per call, so the source sees a gentle rate.
 * Intraday ranges only need refreshing while the market is open. */
async function candleTick() {
  const open = usMarketOpen();
  for (const [range, every] of Object.entries(RANGES)) {
    const period = open || !["1D", "5D"].includes(range) ? every : 30 * 60_000;
    for (const [symbol] of STOCKS) {
      if (Date.now() - (candlesFetchedAt[`${symbol}-${range}`] ?? 0) < period) continue;
      candlesFetchedAt[`${symbol}-${range}`] = Date.now(); // also backs off a failing fetch
      try { await writeCandles(symbol, range); } catch { /* retried next period */ }
      return;
    }
  }
}

/** Median of the fresh quotes, or null unless ≥2 agree within MAX_SPREAD_BPS. */
export function aggregate(values) {
  const quotes = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (quotes.length < 2) return null;
  const mid = quotes.length % 2 ? quotes[(quotes.length - 1) / 2] : (quotes[quotes.length / 2 - 1] + quotes[quotes.length / 2]) / 2;
  const range = quotes[quotes.length - 1] - quotes[0];
  if (range * 10_000 > mid * MAX_SPREAD_BPS) return null;
  return { price: mid, conf: Math.max(range / 2, mid * MIN_CONF_BPS / 10_000), sources: quotes.length };
}

async function sign(id, price, conf, publishTime) {
  const p = BigInt(Math.round(price * 10 ** -EXPO));
  const c = BigInt(Math.max(1, Math.round(conf * 10 ** -EXPO)));
  const inner = keccak256(abi.encode(["bytes32", "uint256", "address", "bytes32", "int64", "uint64", "int32", "uint64"], [TYPEHASH, CHAIN_ID, FEED, id, p, c, EXPO, publishTime]));
  const sig = wallet.signingKey.sign(hashMessage(getBytes(inner))); // EIP-191, as ArcSignedPriceFeed.digest
  const update = abi.encode(["bytes32", "int64", "uint64", "int32", "uint64", "uint8", "bytes32", "bytes32"], [id, p, c, EXPO, publishTime, sig.v, sig.r, sig.s]);
  return { update, price: p.toString(), conf: c.toString(), expo: EXPO, publishTime };
}

let lastDisplay = {};
let lastDisplayAt = 0;

async function tick() {
  const open = FORCE || usMarketOpen();
  const feeds = {};
  const skipped = {};
  if (open) {
    const [a, b] = await Promise.allSettled([cnbc(), nasdaq()]);
    if (a.status === "fulfilled") { lastDisplay = a.value.display; lastDisplayAt = Date.now(); }
    const publishTime = Math.floor(Date.now() / 1000);
    for (const [symbol, id] of STOCKS) {
      const values = [a.status === "fulfilled" ? a.value.regular[symbol] : undefined, b.status === "fulfilled" ? b.value[symbol] : undefined];
      const agg = aggregate(values);
      if (!agg) { skipped[symbol] = values.map((v) => v ?? null); continue; }
      feeds[id] = { symbol, sources: agg.sources, ...(await sign(id, agg.price, agg.conf, publishTime)) };
    }
  } else if (Date.now() - lastDisplayAt > 60_000) {
    // Closed: nothing to sign; refresh the display quotes once a minute.
    try { lastDisplay = (await cnbc()).display; lastDisplayAt = Date.now(); } catch { /* keep the last ones */ }
  }
  // Display-only quotes: unsigned, never accepted on-chain.
  const display = {};
  for (const [symbol, id] of STOCKS) if (lastDisplay[symbol]) display[id] = { symbol, ...lastDisplay[symbol] };
  const body = JSON.stringify({ ok: true, feed: FEED, signer: wallet.address, marketOpen: open, signedAt: Math.floor(Date.now() / 1000), feeds, skipped, display });
  await writeFile(`${OUT}.tmp`, body);
  await rename(`${OUT}.tmp`, OUT);
  return { open, signed: Object.keys(feeds).length, skipped: Object.keys(skipped) };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  // Chart data runs on its own timer so it can never delay a signing tick.
  setInterval(() => { candleTick().catch(() => {}); }, 4_000);
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

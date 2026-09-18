// Stocks listed on ArcStockMarket (tokens aNVDA, aAAPL, …), in listing order (the contract's asset id
// is the index). Feed ids are Pyth's US equity feeds.
export type StockListing = { id: number; symbol: string; name: string; feedId: string; token: string };

export const STOCKS: StockListing[] = [
  { id: 0, symbol: "NVDA", name: "NVIDIA", feedId: "0xb1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593", token: "0x7023e9f5e9eF0E636F8CaDc94ca18bCc724B4675" },
  { id: 1, symbol: "AAPL", name: "Apple", feedId: "0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688", token: "0xED98B427Cecc076E5C9416A1a890ffb6bE03A1c8" },
  { id: 2, symbol: "TSLA", name: "Tesla", feedId: "0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1", token: "0xeD5723D45A9F5d9E435c8572C280DC2E9d07c550" },
  { id: 3, symbol: "SPY", name: "S&P 500 ETF", feedId: "0x19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5", token: "0x722739Af6070EC69a3548AbF40B68a166e02D69e" },
  { id: 4, symbol: "QQQ", name: "Nasdaq-100 ETF", feedId: "0x9695e2b96ea7b3859da9ed25b7a46a920a776e2fdae19a7bcfdf2b219230452d", token: "0xb1F855D2e2B8dA130d6dF376429e07dBb898ae8F" },
  { id: 5, symbol: "MSFT", name: "Microsoft", feedId: "0xd0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1", token: "0x5dD6799aD8933F5776368F6A982d01BE1A67D5E7" },
  { id: 6, symbol: "AMZN", name: "Amazon", feedId: "0xb5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a", token: "0x9523bED27C4608A8a085d072F6c3D25134468Da7" },
  { id: 7, symbol: "GOOGL", name: "Alphabet", feedId: "0x5a48c03e9b9cb337801073ed9d166817473697efff0d138874e0f6a33d6d5aa6", token: "0xF406De48f9C2A2C40B1E0cDd07Da6d2384267563" },
  { id: 8, symbol: "META", name: "Meta", feedId: "0x78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe", token: "0xd59C3d08dfE760F28a789234ed0AaD6f0d140c6b" },
  { id: 9, symbol: "COIN", name: "Coinbase", feedId: "0xfee33f2a978bf32dd6b662b65ba8083c6773b494f8401194ec1870c640860245", token: "0x16b984B6d899f993E8965a01eEf895ff57a854a3" },
];

/** US regular session, 09:30–16:00 New York time, Monday to Friday. Pyth's
 * equity feeds only publish then, so the market can only trade then. Exchange
 * holidays are not modelled; on those the feeds are simply stale. */
export function usMarketOpen(now = new Date()): boolean {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(now).map((p) => [p.type, p.value]));
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

/** New York wall-clock "YYYY-MM-DDTHH:MM" → epoch ms, EDT or EST as it falls. */
function newYorkToEpoch(local: string): number {
  const asUtc = Date.parse(`${local}:00Z`);
  const ny = new Date(new Date(asUtc).toLocaleString("en-US", { timeZone: "America/New_York" }));
  const utc = new Date(new Date(asUtc).toLocaleString("en-US", { timeZone: "UTC" }));
  return asUtc + (utc.getTime() - ny.getTime());
}

/** Next 09:30 New York on a weekday after `now` (exchange holidays not modelled). */
export function nextUsOpen(now = new Date()): Date {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  for (let d = 0; d < 8; d++) {
    const day = new Date(Date.parse(`${today}T12:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
    const at = newYorkToEpoch(`${day}T09:30`);
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6 && at > now.getTime()) return new Date(at);
  }
  return new Date(now.getTime() + 86_400_000);
}

export type StockQuote = { price: number; conf: number; publishTime: number };
export type DisplayQuote = {
  price: number; close: number; reference: number; session: "regular" | "pre-market" | "after-hours" | "closed";
  open: number | null; high: number | null; low: number | null; volume: string; marketCap: string | null; pe: string | null;
  yearHigh: number | null; yearLow: number | null; name: string | null;
};
export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
export const CHART_RANGES = ["1D", "5D", "1M", "6M", "1Y"] as const;
export type ChartRange = (typeof CHART_RANGES)[number];

export async function fetchStockCandles(symbol: string, range: ChartRange): Promise<Candle[]> {
  const response = await fetch(`/data/stock-candles/${symbol}-${range}.json?t=${Math.floor(Date.now() / 30_000)}`);
  if (!response.ok) return [];
  return ((await response.json()) as { candles: Candle[] }).candles ?? [];
}

/** /stocks/AMZN → the AMZN listing; anything else → null. */
export function stockFromPath(pathname: string): StockListing | null {
  const match = pathname.match(/^\/stocks\/([A-Za-z.]+)\/?$/);
  return match ? STOCKS.find((s) => s.symbol === match[1].toUpperCase()) ?? null : null;
}
export type StockPriceBundle = { updates: string[]; prices: Record<string, StockQuote>; display: Record<string, DisplayQuote> };

/** Latest signed prices from Arcodian's price service (ArcSignedPriceFeed).
 * The service writes one bundle every few seconds during the US session; each
 * trade carries the updates for the stocks it prices. `display` holds the
 * latest quote in any session for showing on the page; it is not signed and
 * the contract never sees it. */
export async function fetchStockPrices(feedIds: string[]): Promise<StockPriceBundle> {
  const response = await fetch(`/data/stock-prices.json?t=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error("Price service unavailable");
  const body = await response.json() as {
    feeds?: Record<string, { update: string; price: string; conf: string; expo: number; publishTime: number }>;
    display?: Record<string, DisplayQuote>;
  };
  const prices: Record<string, StockQuote> = {};
  const updates: string[] = [];
  for (const id of feedIds) {
    const feed = body.feeds?.[id.toLowerCase()];
    if (!feed) continue;
    const scale = 10 ** feed.expo;
    prices[id.toLowerCase()] = { price: Number(feed.price) * scale, conf: Number(feed.conf) * scale, publishTime: feed.publishTime };
    updates.push(feed.update);
  }
  return { updates, prices, display: body.display ?? {} };
}

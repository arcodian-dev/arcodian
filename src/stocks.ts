// Stocks listed on ArcStockMarket (tokens aNVDA, aAAPL, …), in listing order (the contract's asset id
// is the index). Feed ids are Pyth's US equity feeds.
export type StockListing = { id: number; symbol: string; name: string; feedId: string };

export const STOCKS: StockListing[] = [
  { id: 0, symbol: "NVDA", name: "NVIDIA", feedId: "0xb1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593" },
  { id: 1, symbol: "AAPL", name: "Apple", feedId: "0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688" },
  { id: 2, symbol: "TSLA", name: "Tesla", feedId: "0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1" },
  { id: 3, symbol: "SPY", name: "S&P 500 ETF", feedId: "0x19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5" },
  { id: 4, symbol: "QQQ", name: "Nasdaq-100 ETF", feedId: "0x9695e2b96ea7b3859da9ed25b7a46a920a776e2fdae19a7bcfdf2b219230452d" },
  { id: 5, symbol: "MSFT", name: "Microsoft", feedId: "0xd0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1" },
  { id: 6, symbol: "AMZN", name: "Amazon", feedId: "0xb5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a" },
  { id: 7, symbol: "GOOGL", name: "Alphabet", feedId: "0x5a48c03e9b9cb337801073ed9d166817473697efff0d138874e0f6a33d6d5aa6" },
  { id: 8, symbol: "META", name: "Meta", feedId: "0x78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe" },
  { id: 9, symbol: "COIN", name: "Coinbase", feedId: "0xfee33f2a978bf32dd6b662b65ba8083c6773b494f8401194ec1870c640860245" },
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

export type PythQuote = { price: number; conf: number; publishTime: number };
export type PythBundle = { updates: string[]; prices: Record<string, PythQuote> };

/** Latest signed updates (and parsed prices) through the same-origin proxy. */
export async function fetchPyth(feedIds: string[]): Promise<PythBundle> {
  const response = await fetch(`/api/pyth-updates.php?ids=${feedIds.join(",")}`, { cache: "no-store" });
  const body = await response.json();
  if (!body.ok) throw new Error(body.error || "Price service unavailable");
  const prices: Record<string, PythQuote> = {};
  for (const [id, p] of Object.entries(body.prices as Record<string, { price: string; conf: string; expo: number; publishTime: number }>)) {
    const scale = 10 ** p.expo;
    prices[id.toLowerCase()] = { price: Number(p.price) * scale, conf: Number(p.conf) * scale, publishTime: p.publishTime };
  }
  return { updates: body.updates, prices };
}

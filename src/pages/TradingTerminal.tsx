import { useEffect, useMemo, useState } from "react";
import SwapPanel from "../components/SwapPanel";
import { TerminalChart, type Candle } from "../components/TerminalChart";
import { ARC_MAINNET } from "../config";
import { imageUrl } from "../shared";
import "./TradingTerminal.css";

type MarketTrade = { side: "BUY" | "SELL"; timestamp?: number; tx: string; user: string; native: string; tokens: string; block?: number; venue?: string };
type MarketRecord = {
  address: string;
  name: string;
  symbol: string;
  image?: string;
  price?: number;
  marketCap?: string;
  liquidity?: string;
  volume24h?: string;
  priceChange24h?: number;
  dex?: string;
  feeTier?: number;
  globalPool?: boolean;
  graduated?: boolean;
  curve?: string;
  pair?: string;
  pool?: string;
  trades?: MarketTrade[];
};
type TapeTrade = MarketTrade & { token: string };

function usdc(raw: string | number | undefined): number {
  return raw === undefined ? 0 : Number(raw) / 1e6;
}

function money(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(2)}K`;
  return `$${value.toFixed(2)}`;
}

function tradePrice(trade: MarketTrade | undefined): number {
  if (!trade?.native || !trade.tokens || BigInt(trade.tokens) <= 0n) return 0;
  return Number(trade.native) / Number(trade.tokens) * 1e12;
}

function mergeTrades(previous: MarketTrade[], incoming: MarketTrade[]): MarketTrade[] {
  return [...previous, ...incoming]
    .filter((trade, index, all) => all.findIndex((candidate) => candidate.tx === trade.tx && candidate.side === trade.side) === index)
    .sort((a, b) => (a.block || 0) - (b.block || 0))
    .slice(-500);
}

function buildCandles(trades: MarketTrade[], timeframe: string): Candle[] {
  const seconds = timeframe === "1m" ? 60 : timeframe === "5m" ? 300 : timeframe === "15m" ? 900 : timeframe === "1H" ? 3600 : 14400;
  const buckets = new Map<number, Array<{ price: number; volume: number }>>();
  for (const trade of trades) {
    const price = tradePrice(trade);
    const timestamp = Number(trade.timestamp || 0);
    if (!price || !timestamp) continue;
    const bucket = Math.floor(timestamp / seconds) * seconds;
    buckets.set(bucket, [...(buckets.get(bucket) || []), { price, volume: usdc(trade.native) }]);
  }
  return [...buckets.entries()].sort(([a], [b]) => a - b).slice(-120).map(([time, points]) => {
    const prices = points.map((point) => point.price);
    return { time, open: prices[0], close: prices.at(-1) || prices[0], high: Math.max(...prices), low: Math.min(...prices), volume: points.reduce((sum, point) => sum + point.volume, 0) };
  });
}

function MarketChart({ timeframe, trades }: { timeframe: string; trades: MarketTrade[] }) {
  const candles = useMemo(() => buildCandles(trades, timeframe), [trades, timeframe]);
  return candles.length ? <TerminalChart candles={candles} priceLabel={(value) => value < 0.000001 ? value.toFixed(12) : value.toFixed(8)} onHover={() => undefined} /> : <div className="terminal-data-empty">No indexed trades for this market yet.</div>;
}

// The venue actually executing trades: the V3 pool once graduated/global,
// the bonding curve before that. Shown so a trader can verify the exact
// onchain contract themselves instead of trusting the UI.
function venueAddress(market: MarketRecord): string {
  return market.pool || market.pair || market.curve || market.address;
}

// Arc markets are AMM-priced (bonding curve pre-graduation, Uniswap V3 pool
// after) — there is no limit order book anywhere in the stack. This used to
// render a fabricated bid/ask ladder computed from arbitrary offsets off the
// last price, which looked like real depth but wasn't backed by anything.
// Real, disclosed pool state instead of a synthetic-but-convincing fake.
function PoolInfo({ market }: { market: MarketRecord }) {
  const venue = venueAddress(market);
  const feePct = market.feeTier ? (market.feeTier / 10_000).toFixed(2) : null;
  return <aside className="terminal-poolinfo">
    <div className="terminal-section-title">Pool <span>{market.dex || "Arc Mainnet"}</span></div>
    <div className="poolinfo-rows">
      <div><span>Venue</span><b>{market.dex || (market.graduated === false ? "Bonding curve" : "—")}</b></div>
      <div><span>Fee tier</span><b>{feePct ? `${feePct}%` : market.graduated === false ? "1.00% curve" : "—"}</b></div>
      <div><span>Liquidity</span><b>{money(usdc(market.liquidity))}</b></div>
      <div><span>24h volume</span><b>{money(usdc(market.volume24h))}</b></div>
      <div><span>Market cap</span><b>{money(usdc(market.marketCap))}</b></div>
    </div>
    <div className="poolinfo-links">
      <a href={`${ARC_MAINNET.explorer}/address/${market.address}`} target="_blank" rel="noreferrer">Token contract ↗</a>
      {venue.toLowerCase() !== market.address.toLowerCase() && <a href={`${ARC_MAINNET.explorer}/address/${venue}`} target="_blank" rel="noreferrer">Trading venue ↗</a>}
    </div>
    <p className="poolinfo-note">Onchain pool state — Arc markets are AMM-priced, so there's no order book to show.</p>
  </aside>;
}

export default function TradingTerminal({ account, activeProvider, chainId, connect }: {
  account: string;
  activeProvider: unknown;
  chainId?: number | null;
  connect: () => void;
}) {
  const tokenAddress = new URLSearchParams(window.location.search).get("token")?.toLowerCase() || "";
  const [market, setMarket] = useState<MarketRecord | null>(null);
  const [marketLoading, setMarketLoading] = useState(true);
  const [tapeTrades, setTapeTrades] = useState<MarketTrade[]>([]);
  const [tapeHealth, setTapeHealth] = useState<"live" | "delayed" | "offline">("delayed");
  const [timeframe, setTimeframe] = useState("5m");
  const [activeSide, setActiveSide] = useState<"buy" | "sell">("buy");
  const mobileChain = chainId === 5042;

  // Metadata (price, mcap, liquidity, dex/fee, and an initial trade history
  // seed) — sourced from the 30s full-rescan snapshot, which is fine since
  // none of this changes faster than that server-side cycle anyway.
  useEffect(() => {
    let alive = true;
    setMarketLoading(true);
    setTapeTrades([]);
    const load = () => fetch(`/data/mainnet-market-index.json?ts=${Date.now()}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("Market index unavailable")))
      .then((data) => {
        const records = [...(Array.isArray(data?.launches) ? data.launches : []), ...(Array.isArray(data?.pools) ? data.pools : [])];
        const item = records.find((row: MarketRecord) => row.address?.toLowerCase() === tokenAddress) || null;
        if (!alive) return;
        setMarket(item || null);
        if (item?.trades?.length) setTapeTrades((previous) => mergeTrades(previous, item.trades!));
      })
      .catch(() => { if (alive) setMarket(null); })
      .finally(() => { if (alive) setMarketLoading(false); });
    load();
    const timer = window.setInterval(load, 5_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [tokenAddress]);

  // mainnet-live-tape.mjs ticks every second — this is what actually makes
  // "live trades" and chart movement live, instead of capped at the 30s
  // snapshot above (found 2026-08-02: /terminal polled that snapshot every
  // 15s while /market's own embedded desk already polled it every 3s, so
  // /terminal visibly lagged an identical data source for no reason — this
  // dedicated tape fixes both the staleness and the gap between the two).
  useEffect(() => {
    if (!tokenAddress) return;
    let alive = true;
    let consecutiveFailures = 0;
    const poll = () => fetch("/data/mainnet-live-tape.json", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("Tape unavailable")))
      .then((tape: { indexedAt?: string; trades?: TapeTrade[] }) => {
        if (!alive) return;
        consecutiveFailures = 0;
        setTapeHealth(tape.indexedAt && Date.now() - Date.parse(tape.indexedAt) <= 6_000 ? "live" : "delayed");
        const mine = (tape.trades || []).filter((trade) => trade.token.toLowerCase() === tokenAddress);
        if (mine.length) setTapeTrades((previous) => mergeTrades(previous, mine));
      })
      .catch(() => {
        if (!alive) return;
        consecutiveFailures += 1;
        if (consecutiveFailures >= 3) setTapeHealth("offline");
      });
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 1_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [tokenAddress]);

  const price = market?.price || tradePrice(tapeTrades.at(-1)) || 0;
  const feedLabel = tapeHealth === "live" ? "Live" : tapeHealth === "delayed" ? "Delayed" : "Offline";
  if (marketLoading) return <main className="trading-terminal-page"><div className="terminal-data-empty">Loading selected Arc Mainnet market…</div></main>;
  if (!market) return <main className="trading-terminal-page"><div className="terminal-data-empty">Select a token from Markets to open its terminal.</div></main>;
  return <main className="trading-terminal-page">
    <header className="terminal-header">
      <a className="terminal-brand" href="/market"><span>{market.image ? <img src={imageUrl(market.image)} alt="" /> : market.symbol.slice(0, 2)}</span><b>{market.symbol}</b><small>/ USDC · {market.dex || "MAINNET"}</small></a>
      <div className="terminal-price"><strong>{price > 0 ? `$${price.toFixed(8)}` : "Price unavailable"}</strong><em>{market.priceChange24h == null ? "—" : `${market.priceChange24h >= 0 ? "+" : ""}${market.priceChange24h.toFixed(2)}%`}</em></div>
      <div className="terminal-metrics"><span><small>MKT CAP</small><b>{money(usdc(market.marketCap))}</b></span><span><small>VOL 24H</small><b>{money(usdc(market.volume24h))}</b></span><span><small>LIQUIDITY</small><b>{money(usdc(market.liquidity))}</b></span></div>
      <div className="terminal-actions"><span className={mobileChain ? "terminal-network online" : "terminal-network"}>● {mobileChain ? "Arc Mainnet" : "Arc · connect wallet"}</span>{account ? <span className="terminal-wallet">{account.slice(0, 6)}…{account.slice(-4)}</span> : <button onClick={connect}>Connect wallet</button>}<a href="/market">Exit terminal</a></div>
    </header>
    <div className="terminal-layout">
      <section className="terminal-main-column">
        <div className="terminal-card terminal-chart-card">
          <div className="terminal-toolbar"><div>{["1m", "5m", "15m", "1H", "4H"].map((item) => <button key={item} className={timeframe === item ? "active" : ""} onClick={() => setTimeframe(item)}>{item}</button>)}</div><span className={`streaming ${tapeHealth}`}><i /> {feedLabel}</span></div>
          <div className="terminal-chart-wrap"><MarketChart timeframe={timeframe} trades={tapeTrades} /></div>
          <div className="terminal-chart-footer"><span>Price · USDC</span><span>Volume</span><span>Contract markets only · Arc Mainnet</span></div>
        </div>
        <div className="terminal-card terminal-trades">
          <div className="terminal-section-title">Live trades <span>{tapeTrades.length} indexed</span></div>
          <div className="trades-head"><span>Type</span><span>Price</span><span>Amount</span><span>Value</span><span>Wallet</span></div>
          <div className="trades-body">{tapeTrades.length ? [...tapeTrades].reverse().map((trade, index) => <div className="trade-row" key={`${trade.tx}-${index}`}><b className={trade.side === "BUY" ? "buy" : "sell"}>{trade.side}</b><span>{tradePrice(trade) > 0 ? tradePrice(trade).toFixed(8) : "—"}</span><span>{Number(trade.tokens) > 0 ? (Number(trade.tokens) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 4 }) : "—"} {market.symbol}</span><span>{money(usdc(trade.native))}</span><span>{trade.user.slice(0, 6)}…{trade.user.slice(-4)}</span></div>) : <div className="terminal-data-empty">No indexed trades for this market yet.</div>}</div>
        </div>
      </section>
      <PoolInfo market={market} />
      <aside className="terminal-execution terminal-card">
        <div className="execution-tabs"><button className={activeSide === "buy" ? "active buy" : ""} onClick={() => setActiveSide("buy")}>Buy</button><button className={activeSide === "sell" ? "active sell" : ""} onClick={() => setActiveSide("sell")}>Sell</button></div>
        <div className="execution-context"><span>Arcodian route engine</span><b>{activeSide === "buy" ? `Buy ${market.symbol}` : `Sell ${market.symbol}`}</b><small>Best executable route · 0.30% protocol fee where applicable</small></div>
        <SwapPanel account={account} activeProvider={activeProvider as never} onConnect={connect} chainId={chainId} initialTokenAddress={market.address} />
      </aside>
    </div>
  </main>;
}

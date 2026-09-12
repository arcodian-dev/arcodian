import { useEffect, useMemo, useRef, useState } from "react";
import { Contract, formatEther } from "ethers";
import SwapPanel from "../components/SwapPanel";
import { TerminalChart, type Candle } from "../components/TerminalChart";
import { ARC_MAINNET } from "../config";
import { arcProvider, CoinIcon, rpcUrlsFor } from "../shared";
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
  creator?: string;
  reserve?: string;
  threshold?: string;
  trades?: MarketTrade[];
};
type TapeTrade = MarketTrade & { token: string };

function usdc(raw: string | number | undefined, decimals = 18): number {
  // Canonical Arc launch values use native USDC (18 decimals). Radar/global
  // ERC-20 aggregates and V3 swap deltas use 6-decimal USDC.
  return raw === undefined ? 0 : Number(raw) / 10 ** decimals;
}

function money(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(2)}K`;
  return `$${value.toFixed(2)}`;
}

function tradePrice(trade: MarketTrade | undefined, globalPool = false): number {
  if (!trade?.native || !trade.tokens || BigInt(trade.tokens) <= 0n) return 0;
  // Canonical launches have 18-decimal quote and token legs. Global pools
  // have a 6-decimal USDC quote leg, so normalize that ratio once.
  return Number(trade.native) / Number(trade.tokens) * (globalPool ? 1e12 : 1);
}

function mergeTrades(previous: MarketTrade[], incoming: MarketTrade[]): MarketTrade[] {
  return [...previous, ...incoming]
    .filter((trade, index, all) => all.findIndex((candidate) => candidate.tx === trade.tx && candidate.side === trade.side) === index)
    .sort((a, b) => (a.block || 0) - (b.block || 0))
    .slice(-500);
}

function buildCandles(trades: MarketTrade[], timeframe: string, globalPool = false): Candle[] {
  const seconds = timeframe === "1m" ? 60 : timeframe === "5m" ? 300 : timeframe === "15m" ? 900 : timeframe === "1H" ? 3600 : 14400;
  const buckets = new Map<number, Array<{ price: number; volume: number }>>();
  for (const trade of trades) {
    const price = tradePrice(trade, globalPool);
    const timestamp = Number(trade.timestamp || 0);
    if (!price || !timestamp) continue;
    const bucket = Math.floor(timestamp / seconds) * seconds;
    buckets.set(bucket, [...(buckets.get(bucket) || []), { price, volume: usdc(trade.native, globalPool ? 6 : 18) }]);
  }
  return [...buckets.entries()].sort(([a], [b]) => a - b).slice(-120).map(([time, points]) => {
    const prices = points.map((point) => point.price);
    return { time, open: prices[0], close: prices.at(-1) || prices[0], high: Math.max(...prices), low: Math.min(...prices), volume: points.reduce((sum, point) => sum + point.volume, 0) };
  });
}

// A Radar-discovered token with liquidity spread across several external
// AMMs (its dex field reads e.g. "Uniswap V2 + Uniswap V3 + Uniswap V4")
// has no single pool contract to tail Swap events from — there is no chart
// or live tape to ever populate for it, by construction, not because
// anything is broken. That's most of the catalog (Radar surfaces ~1000
// tokens; only the ones graduated through Arcodian itself or trading on a
// single external V3 pool have one indexable venue). Say so plainly instead
// of leaving a permanent "loading" look on a majority of listed tokens.
function noIndexableVenue(market: MarketRecord): boolean {
  return Boolean(market.globalPool) && !market.pool && !market.pair && !market.curve;
}

function ChartEmptyState({ market }: { market: MarketRecord }) {
  if (noIndexableVenue(market)) {
    return <div className="terminal-data-empty terminal-data-empty-detail">
      <p>No single onchain pool to chart.</p>
      <small>{market.symbol} trades across {market.dex || "multiple external venues"} — Arcodian can't tail one contract's swaps for a price feed. Price, market cap, and volume above still come from Radar; use {market.dex?.split(" + ")[0] || "the venue"}'s own chart for live candles.</small>
    </div>;
  }
  return <div className="terminal-data-empty">No trades indexed for this market yet — check back shortly.</div>;
}

function MarketChart({ market, timeframe, trades }: { market: MarketRecord; timeframe: string; trades: MarketTrade[] }) {
  const candles = useMemo(() => buildCandles(trades, timeframe, Boolean(market.globalPool)), [trades, timeframe, market.globalPool]);
  return candles.length ? <TerminalChart candles={candles} priceLabel={(value) => value < 0.000001 ? value.toFixed(12) : value.toFixed(8)} onHover={() => undefined} /> : <ChartEmptyState market={market} />;
}

// The venue actually executing trades: the V3 pool once graduated/global,
// the bonding curve before that. Shown so a trader can verify the exact
// onchain contract themselves instead of trusting the UI.
function venueAddress(market: MarketRecord): string {
  return market.pool || market.pair || market.curve || market.address;
}

// Same bonding-curve progress the Market cards already show (reserve of
// threshold, both as % and an absolute amount) — the Terminal's PoolInfo
// used to only say "1.00% curve" with no sense of how close to graduating,
// the one piece of Pons's coin page that had a real, missing counterpart
// here rather than just a color/spacing difference.
function CurveProgress({ market }: { market: MarketRecord }) {
  if (!market.curve || !market.threshold) return null;
  if (market.graduated) return <div className="poolinfo-progress graduated"><span>Graduated</span><b>Live on Arc DEX / Uniswap V3</b></div>;
  const reserve = usdc(market.reserve, market.globalPool ? 6 : 18);
  const threshold = usdc(market.threshold, market.globalPool ? 6 : 18);
  const pct = threshold > 0 ? Math.min(100, (reserve / threshold) * 100) : 0;
  return <div className="poolinfo-progress">
    <div className="poolinfo-progress-head"><span>Bonding curve</span><b>{pct.toFixed(1)}% to graduation</b></div>
    <div className="poolinfo-progress-bar"><i style={{ width: `${pct}%` }} /></div>
    <small>{reserve.toLocaleString(undefined, { maximumFractionDigits: 2 })} of {threshold.toLocaleString(undefined, { maximumFractionDigits: 0 })} USDC raised</small>
  </div>;
}

const CREATOR_FEE_ABI = ["function creatorFeesAccrued() view returns(uint256)", "function creator() view returns(address)", "function withdrawCreatorFees() external"];

// V11-only feature (creator fee split — see contracts/src/ArcPumpV11.sol).
// Reads live, not from the index snapshot: this is a claimable balance, so a
// 30s-stale number could show "0" right after a real accrual or, worse,
// look claimable after it's already been withdrawn. Silently renders
// nothing for anything that isn't a V11 curve (creatorFeesAccrued() reverts
// on V9/V10/V8 — the ABI doesn't exist there), same fail-quiet pattern the
// rest of this file uses for optional per-engine features.
function CreatorFeeSection({ market, account, activeProvider }: {
  market: MarketRecord;
  account: string;
  activeProvider: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } | null;
}) {
  const [accrued, setAccrued] = useState<bigint | null>(null);
  const [supported, setSupported] = useState(true);
  const [claiming, setClaiming] = useState(false);
  const [status, setStatus] = useState("");
  const curve = market.curve;
  // User-specified privacy rule: creator-fee info shows ONLY to the wallet
  // that IS this coin's creator, connected. Everyone else sees nothing here
  // (not even a disabled/blurred hint) — the balance is technically public
  // on any block explorer, but this UI never surfaces it to a non-creator.
  const isCreator = Boolean(account) && Boolean(market.creator) && account.toLowerCase() === (market.creator || "").toLowerCase();

  useEffect(() => {
    if (!curve || !isCreator) return;
    let alive = true;
    const provider = arcProvider(ARC_MAINNET);
    const poll = () => new Contract(curve, CREATOR_FEE_ABI, provider).creatorFeesAccrued()
      .then((value: unknown) => { if (alive) { setAccrued(value as bigint); setSupported(true); } })
      .catch(() => { if (alive) setSupported(false); });
    void poll();
    const timer = window.setInterval(poll, 10_000);
    return () => { alive = false; window.clearInterval(timer); provider.destroy(); };
  }, [curve, isCreator]);

  if (!curve || !isCreator || !supported || accrued == null) return null;

  async function claim() {
    if (!activeProvider || !curve) return;
    setClaiming(true);
    setStatus("Confirm the claim in your wallet…");
    try {
      const iface = new Contract(curve, CREATOR_FEE_ABI);
      const data = iface.interface.encodeFunctionData("withdrawCreatorFees", []);
      const hash = await activeProvider.request({ method: "eth_sendTransaction", params: [{ from: account, to: curve, data }] });
      setStatus(typeof hash === "string" ? "Claim submitted — it'll land in a few seconds." : "Claim submitted.");
    } catch (error) {
      setStatus((error as { message?: string })?.message?.slice(0, 120) || "Claim failed.");
    } finally {
      setClaiming(false);
    }
  }

  return <div className="poolinfo-creator-fee">
    <div className="terminal-section-title">Your creator fee <span>1% trading fee, split</span></div>
    <div className="creator-fee-stat">
      <span>Claimable now</span>
      <b>{Number(formatEther(accrued)).toLocaleString(undefined, { maximumFractionDigits: 6 })} USDC</b>
    </div>
    <p className="poolinfo-note">Visible only to you — you're the creator wallet for {market.symbol}.</p>
    <button className="creator-fee-claim" disabled={claiming || accrued === 0n} onClick={() => void claim()}>{claiming ? "Claiming…" : accrued === 0n ? "Nothing to claim yet" : "Claim creator fee"}</button>
    {status && <p className="poolinfo-note">{status}</p>}
  </div>;
}

// Arc markets are AMM-priced (bonding curve pre-graduation, Uniswap V3 pool
// after) — there is no limit order book anywhere in the stack. This used to
// render a fabricated bid/ask ladder computed from arbitrary offsets off the
// last price, which looked like real depth but wasn't backed by anything.
// Real, disclosed pool state instead of a synthetic-but-convincing fake.
function PoolInfo({ market, account, activeProvider }: {
  market: MarketRecord;
  account: string;
  activeProvider: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } | null;
}) {
  const venue = venueAddress(market);
  const feePct = market.feeTier ? (market.feeTier / 10_000).toFixed(2) : null;
  return <aside className="terminal-poolinfo">
    <div className="terminal-section-title">Pool <span>{market.dex || "Arc Mainnet"}</span></div>
    <CurveProgress market={market} />
    <div className="poolinfo-rows">
      <div><span>Venue</span><b>{market.dex || (market.graduated === false ? "Bonding curve" : "—")}</b></div>
      <div><span>Fee tier</span><b>{feePct ? `${feePct}%` : market.graduated === false ? "1.00% curve" : "—"}</b></div>
      <div><span>Liquidity</span><b>{money(usdc(market.liquidity, market.globalPool ? 6 : 18))}</b></div>
      <div><span>24h volume</span><b>{money(usdc(market.volume24h, market.globalPool ? 6 : 18))}</b></div>
      <div><span>Market cap</span><b>{money(usdc(market.marketCap, market.globalPool ? 6 : 18))}</b></div>
    </div>
    <div className="poolinfo-links">
      <a href={`${ARC_MAINNET.explorer}/address/${market.address}`} target="_blank" rel="noreferrer">Token contract ↗</a>
      {venue.toLowerCase() !== market.address.toLowerCase() && <a href={`${ARC_MAINNET.explorer}/address/${venue}`} target="_blank" rel="noreferrer">Trading venue ↗</a>}
    </div>
    <CreatorFeeSection market={market} account={account} activeProvider={activeProvider} />
    <p className="poolinfo-note">Onchain pool state — Arc markets are AMM-priced, so there's no order book to show.</p>
  </aside>;
}

// Shown for the ~1-2s the index snapshot takes to resolve. A shimmer in the
// exact shape of the real layout reads as "already loading your terminal"
// instead of the blank-then-pop a plain loading string gives — the terminal
// feeling instant is as much about what's on screen in that first second as
// it is about the actual data latency.
function TerminalSkeleton() {
  return <div className="terminal-skeleton">
    <div className="skel-header"><div className="skel s-brand" /><div className="skel s-price" /><div className="skel s-metrics" /></div>
    <div className="skel-layout">
      <div className="skel-main"><div className="skel s-chart" /><div className="skel s-trades" /></div>
      <div className="skel s-pool" />
      <div className="skel s-execution" />
    </div>
  </div>;
}

export default function TradingTerminal({ account, activeProvider, chainId, connect }: {
  account: string;
  activeProvider: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } | null;
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
  const [priceFlash, setPriceFlash] = useState<"up" | "down" | null>(null);
  const lastPriceRef = useRef(0);
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

  // Every price/chart/trade shown here is Arc Mainnet data — but SwapPanel
  // silently mirrors whatever chain the connected wallet reports (needed so
  // it also works for Arc Testnet elsewhere in the app). Without this check,
  // a wallet left on Arc Testnet would show real testnet balances/tokens
  // right next to mainnet market data with no indication anything was
  // wrong (found 2026-08-02: a connected testnet wallet "read testnet
  // balance" here with no warning at all).
  const wrongNetwork = Boolean(account) && chainId != null && chainId !== ARC_MAINNET.id;
  async function switchToArcMainnet() {
    if (!activeProvider) { connect(); return; }
    try {
      await activeProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ARC_MAINNET.hexId }] });
    } catch {
      try {
        await activeProvider.request({
          method: "wallet_addEthereumChain",
          params: [{ chainId: ARC_MAINNET.hexId, chainName: ARC_MAINNET.name, nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: rpcUrlsFor(ARC_MAINNET), blockExplorerUrls: [ARC_MAINNET.explorer] }],
        });
      } catch { /* user declined or wallet doesn't support programmatic network add */ }
    }
  }

  const price = market?.price || tradePrice(tapeTrades.at(-1), Boolean(market?.globalPool)) || 0;
  const feedLabel = tapeHealth === "live" ? "Live" : tapeHealth === "delayed" ? "Delayed" : "Offline";
  // A ticking number is the one signal a trader trusts more than a "Live"
  // badge — flashing the exact digits that moved (briefly, then settling
  // back) reads as "this terminal is actually watching the chain" in a way
  // a static price never does, with no extra polling cost since it's driven
  // by the price this component already recomputes every tick.
  useEffect(() => {
    if (price > 0 && lastPriceRef.current > 0 && price !== lastPriceRef.current) {
      setPriceFlash(price > lastPriceRef.current ? "up" : "down");
      const timer = window.setTimeout(() => setPriceFlash(null), 620);
      lastPriceRef.current = price;
      return () => window.clearTimeout(timer);
    }
    if (price > 0) lastPriceRef.current = price;
  }, [price]);
  if (marketLoading) return <main className="trading-terminal-page"><TerminalSkeleton /></main>;
  if (!market) return <main className="trading-terminal-page"><div className="terminal-data-empty">Select a token from Markets to open its terminal.</div></main>;
  return <main className="trading-terminal-page">
    <header className="terminal-header">
      <a className="terminal-brand" href="/market"><span><CoinIcon image={market.image} fallback={market.symbol.slice(0, 2)} /></span><b>{market.symbol}</b><small>/ USDC · {market.dex || "MAINNET"}</small></a>
      <div className="terminal-price"><strong className={priceFlash ? `flash-${priceFlash}` : ""}>{price > 0 ? `$${price.toFixed(8)}` : "Price unavailable"}</strong><em className={market.priceChange24h == null ? "" : market.priceChange24h >= 0 ? "up" : "down"}>{market.priceChange24h == null ? "—" : `${market.priceChange24h >= 0 ? "+" : ""}${market.priceChange24h.toFixed(2)}%`}</em></div>
      <div className="terminal-metrics"><span><small>MKT CAP</small><b>{money(usdc(market.marketCap, market.globalPool ? 6 : 18))}</b></span><span><small>VOL 24H</small><b>{money(usdc(market.volume24h, market.globalPool ? 6 : 18))}</b></span><span><small>LIQUIDITY</small><b>{money(usdc(market.liquidity, market.globalPool ? 6 : 18))}</b></span></div>
      <div className="terminal-actions"><span className={wrongNetwork ? "terminal-network wrong" : mobileChain ? "terminal-network online" : "terminal-network"}>● {wrongNetwork ? "Wrong network" : mobileChain ? "Arc Mainnet" : "Arc · connect wallet"}</span>{account ? <span className="terminal-wallet">{account.slice(0, 6)}…{account.slice(-4)}</span> : <button onClick={connect}>Connect wallet</button>}<a href="/market">Exit terminal</a></div>
    </header>
    {wrongNetwork && <div className="terminal-network-banner">Your wallet is on a different network than this market. {market.symbol} trades on <b>Arc Mainnet</b> — switch to see your real balance and trade. <button onClick={() => void switchToArcMainnet()}>Switch to Arc Mainnet</button></div>}
    <div className="terminal-layout">
      <section className="terminal-main-column">
        <div className="terminal-card terminal-chart-card">
          <div className="terminal-toolbar"><div>{["1m", "5m", "15m", "1H", "4H"].map((item) => <button key={item} className={timeframe === item ? "active" : ""} onClick={() => setTimeframe(item)}>{item}</button>)}</div><span className={`streaming ${tapeHealth}`}><i /> {feedLabel}</span></div>
          <div className="terminal-chart-wrap"><MarketChart market={market} timeframe={timeframe} trades={tapeTrades} /></div>
          <div className="terminal-chart-footer"><span>Price · USDC</span><span>Volume</span><span>Contract markets only · Arc Mainnet</span></div>
        </div>
        <div className="terminal-card terminal-trades">
          <div className="terminal-section-title">Live trades <span>{tapeTrades.length} indexed</span></div>
          <div className="trades-head"><span>Type</span><span>Price</span><span>Amount</span><span>Value</span><span>Wallet</span></div>
          {/* tapeTrades holds up to 500 (mergeTrades' cap, needed so the
              chart has enough history at wider timeframes) — rendering all
              500 as DOM rows on every 1s tick is what made this list feel
              janky. Only the newest ~120 are ever visible in this panel
              anyway, so slice before mapping instead of after. */}
          <div className="trades-body">{tapeTrades.length ? [...tapeTrades].reverse().slice(0, 120).map((trade, index) => <div className="trade-row" key={`${trade.tx}-${index}`}><b className={trade.side === "BUY" ? "buy" : "sell"}>{trade.side}</b><span>{tradePrice(trade, Boolean(market.globalPool)) > 0 ? tradePrice(trade, Boolean(market.globalPool)).toFixed(8) : "—"}</span><span>{Number(trade.tokens) > 0 ? (Number(trade.tokens) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 4 }) : "—"} {market.symbol}</span><span>{money(usdc(trade.native, market.globalPool ? 6 : 18))}</span><span>{trade.user.slice(0, 6)}…{trade.user.slice(-4)}</span></div>) : <ChartEmptyState market={market} />}</div>
        </div>
      </section>
      <PoolInfo market={market} account={account} activeProvider={activeProvider} />
      <aside className="terminal-execution terminal-card">
        <div className="execution-tabs"><button className={activeSide === "buy" ? "active buy" : ""} onClick={() => setActiveSide("buy")}>Buy</button><button className={activeSide === "sell" ? "active sell" : ""} onClick={() => setActiveSide("sell")}>Sell</button></div>
        <div className="execution-context"><span>Arcodian route engine</span><b>{activeSide === "buy" ? `Buy ${market.symbol}` : `Sell ${market.symbol}`}</b><small>Best executable route · 0.30% protocol fee where applicable</small></div>
        {wrongNetwork ? (
          <div className="terminal-data-empty">Switch your wallet to Arc Mainnet (banner above) to trade {market.symbol} — it doesn't exist on the network your wallet is currently connected to.</div>
        ) : (
          <SwapPanel account={account} activeProvider={activeProvider} onConnect={connect} chainId={chainId} initialTokenAddress={market.address} />
        )}
      </aside>
    </div>
  </main>;
}

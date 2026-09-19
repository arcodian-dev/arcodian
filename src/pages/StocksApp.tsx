import { useCallback, useEffect, useState } from "react";
import { BrowserProvider, Contract, Interface, JsonRpcProvider, formatEther, id as selectorOf, parseEther } from "ethers";
import { ARC_MAINNET, ARC_MAINNET_CONTRACTS } from "../config";
import { ensureWalletChain } from "../shared";
import { StockChart } from "../components/StockChart";
import { CHART_RANGES, STOCKS, fetchStockCandles, fetchStockPrices, nextUsOpen, stockFromPath, usMarketOpen, type Candle, type ChartRange, type DisplayQuote, type StockQuote } from "../stocks";
import { describeTxError } from "../txError";
import { sendWithMargin } from "../txGas";
import "./LendApp.css";
import "./StocksApp.css";

type Props = { account: string; chainId: number | null; activeProvider: EthereumProvider | null; connect: () => void; disconnect: () => void };
type Pool = { balance: number; openInterest: number; lpShares: number; totalShares: number; lockedUntil: number; nav: number | null; holdings: number[]; caps: number[]; exposure: number[]; paused: boolean; walletUsdc: number };
type Stats = { volume: number; lpFees: number; trades: number; traders: number; providers: number };

const MARKET = ARC_MAINNET_CONTRACTS.arcStockMarket;
/** Block the market was deployed in; its event history starts here. */
const MARKET_DEPLOY_BLOCK = 21_579_040;
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const read = new JsonRpcProvider(ARC_MAINNET.rpc, ARC_MAINNET.id, { staticNetwork: true, batchMaxCount: 1 });
const MARKET_ABI = [
  "function buy(uint256 id, uint256 minShares, bytes[] updates) payable returns (uint256)",
  "function sell(uint256 id, uint256 shares, uint256 minUsdc, bytes[] updates) payable returns (uint256)",
  "function deposit(bytes[] updates) payable returns (uint256)",
  "function withdraw(uint256 shares, bytes[] updates) payable returns (uint256)",
  "function assets(uint256) view returns (address token, bytes32 feedId, uint256 maxOpenInterest, uint256 lastPrice)",
  "function poolBalance() view returns (uint256)", "function totalOpenInterest() view returns (uint256)", "function openInterest(uint256) view returns (uint256)",
  "function netAssetValue() view returns (uint256)", "function totalShares() view returns (uint256)",
  "function sharesOf(address) view returns (uint256)", "function lockedUntil(address) view returns (uint256)", "function paused() view returns (bool)",
  "event Bought(address indexed trader, uint256 indexed id, uint256 usdcIn, uint256 shares, uint256 price, uint256 fee)",
  "event Sold(address indexed trader, uint256 indexed id, uint256 shares, uint256 usdcOut, uint256 price, uint256 fee)",
  "event Deposited(address indexed provider, uint256 usdc, uint256 shares)",
];
const market = new Interface(MARKET_ABI);
const token = new Interface(["function balanceOf(address) view returns (uint256)"]);
const multicall = new Contract(MULTICALL3, [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])",
  "function getEthBalance(address) view returns (uint256)",
], read);
const FEE = 0.003;
const SLIPPAGE = 0.01;
const GAS_RESERVE = 0.02; // USDC kept back for gas when a buy uses "Max"
const MIN_FIRST_DEPOSIT = 1;
const ALL_FEEDS = STOCKS.map((s) => s.feedId);
/** Contract errors a trader can actually hit, in words. */
const REVERTS: Record<string, string> = {
  [selectorOf("StalePrice()").slice(0, 10)]: "The price expired while the wallet was open (prices are valid for 60 seconds). Try again.",
  [selectorOf("Slippage()").slice(0, 10)]: "The price moved more than 1% before the trade landed. Try again.",
  [selectorOf("CapExceeded()").slice(0, 10)]: "This trade is above the open-interest cap for this stock or the pool. Try a smaller amount.",
  [selectorOf("Locked()").slice(0, 10)]: "Your deposit is still inside its 15-minute lock.",
  [selectorOf("IsPaused()").slice(0, 10)]: "The market is paused.",
  [selectorOf("Insolvent()").slice(0, 10)]: "The pool cannot cover this sale right now.",
  [selectorOf("BadPrice()").slice(0, 10)]: "The price band is too wide to trade safely right now.",
};
const short = (value: string) => value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "Connect wallet";
const usd = (value: number, digits = 2) => value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const toWei = (value: number) => parseEther(value.toFixed(18).replace(/\.?0+$/, "") || "0");
const ether = (hex: string) => Number(formatEther(BigInt(hex)));

function explainError(error: unknown): string {
  const text = (() => { try { return JSON.stringify(error); } catch { return String(error); } })();
  for (const [selector, message] of Object.entries(REVERTS)) if (text.includes(selector.slice(2))) return message;
  if (error instanceof Error && !("code" in error)) return error.message;
  return describeTxError(error);
}

/** Absolute times are shown in UTC everywhere on the site. */
const utcTime = (seconds: number) => `${new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;

function countdown(to: Date): string {
  const minutes = Math.max(0, Math.round((to.getTime() - Date.now()) / 60_000));
  const d = Math.floor(minutes / 1440), h = Math.floor((minutes % 1440) / 60), m = minutes % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

export default function StocksApp({ account, chainId, activeProvider, connect, disconnect }: Props) {
  const [quotes, setQuotes] = useState<Record<string, StockQuote>>({});
  const [display, setDisplay] = useState<Record<string, DisplayQuote>>({});
  const [priceError, setPriceError] = useState("");
  const [selected, setSelected] = useState(() => stockFromPath(window.location.pathname)?.id ?? 0);
  const [range, setRange] = useState<ChartRange>("1D");
  const [candles, setCandles] = useState<Candle[] | null>(null); // null while loading
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [lpAmount, setLpAmount] = useState("");
  const [pool, setPool] = useState<Pool | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const open = usMarketOpen(new Date(clock));
  const onArc = chainId === ARC_MAINNET.id;
  const stock = STOCKS[selected];
  const quote = quotes[stock.feedId];
  const shown = display[stock.feedId];
  const now = Math.floor(clock / 1000);
  const fresh = (q?: StockQuote) => Boolean(q && now - q.publishTime <= 45);

  // /stocks/AMZN is the AMZN page; clicking a stock updates the URL and the
  // back button walks back through stocks.
  const choose = (next: number) => {
    setSelected(next); setAmount("");
    const path = `/stocks/${STOCKS[next].symbol}`;
    if (window.location.pathname !== path) window.history.pushState({}, "", path);
  };
  useEffect(() => {
    const onPop = () => setSelected(stockFromPath(window.location.pathname)?.id ?? 0);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => { document.title = `${stock.symbol} · Arcodian Stocks`; }, [stock.symbol]);

  // Prices every 3 s (the service signs every 5 s); clock for badges.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      setClock(Date.now());
      try {
        const bundle = await fetchStockPrices(ALL_FEEDS);
        if (alive) { setQuotes(bundle.prices); setDisplay(bundle.display); setPriceError(""); }
      } catch (error) { if (alive) setPriceError(error instanceof Error ? error.message : "Price service unavailable"); }
    };
    void load();
    const timer = window.setInterval(load, 3_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  // Chart candles for the selected stock and range; intraday refreshes each minute.
  useEffect(() => {
    let alive = true;
    const load = async () => { const next = await fetchStockCandles(stock.symbol, range).catch(() => [] as Candle[]); if (alive) setCandles(next); };
    setCandles(null);
    void load();
    const timer = window.setInterval(load, range === "1D" ? 60_000 : 300_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [stock.symbol, range]);

  // Whole pool and wallet state in one Multicall3 round trip.
  const refresh = useCallback(async () => {
    try {
      const calls: { target: string; allowFailure: boolean; callData: string }[] = [];
      const add = (target: string, iface: Interface, fn: string, args: unknown[] = [], allowFailure = false) => { calls.push({ target, allowFailure, callData: iface.encodeFunctionData(fn, args) }); return calls.length - 1; };
      const iBalance = add(MARKET, market, "poolBalance"), iOi = add(MARKET, market, "totalOpenInterest"), iShares = add(MARKET, market, "totalShares"), iPaused = add(MARKET, market, "paused");
      const iNav = add(MARKET, market, "netAssetValue", [], true); // needs fresh prices once there is open interest
      const iAssets = STOCKS.map((s) => add(MARKET, market, "assets", [s.id]));
      const iExposure = STOCKS.map((s) => add(MARKET, market, "openInterest", [s.id]));
      let iLp = -1, iLock = -1, iWallet = -1, iHold: number[] = [];
      if (account) {
        iLp = add(MARKET, market, "sharesOf", [account]); iLock = add(MARKET, market, "lockedUntil", [account]);
        iWallet = add(MULTICALL3, multicall.interface, "getEthBalance", [account]);
        iHold = STOCKS.map((s) => add(s.token, token, "balanceOf", [account]));
      }
      const results: { success: boolean; returnData: string }[] = await multicall.aggregate3(calls);
      const word = (i: number) => results[i].returnData;
      setPool({
        balance: ether(word(iBalance)), openInterest: ether(word(iOi)), totalShares: ether(word(iShares)), paused: BigInt(word(iPaused)) === 1n,
        nav: results[iNav].success ? ether(word(iNav)) : null,
        caps: iAssets.map((i) => Number(formatEther(market.decodeFunctionResult("assets", word(i)).maxOpenInterest))),
        exposure: iExposure.map((i) => ether(word(i))),
        lpShares: iLp >= 0 ? ether(word(iLp)) : 0, lockedUntil: iLock >= 0 ? Number(BigInt(word(iLock))) : 0,
        walletUsdc: iWallet >= 0 ? ether(word(iWallet)) : 0, holdings: STOCKS.map((_, k) => (iHold[k] !== undefined ? ether(word(iHold[k])) : 0)),
      });
    } catch { /* keep the last snapshot; prices and trading still work */ }
  }, [account]);
  useEffect(() => { void refresh(); const timer = window.setInterval(refresh, 15_000); return () => window.clearInterval(timer); }, [refresh]);

  // Volume and LP earnings from the market's own events.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const head = await read.getBlockNumber();
        const topics = [[market.getEvent("Bought")!.topicHash, market.getEvent("Sold")!.topicHash, market.getEvent("Deposited")!.topicHash]];
        let volume = 0, fees = 0, trades = 0;
        const traders = new Set<string>(), providers = new Set<string>();
        for (let from = MARKET_DEPLOY_BLOCK; from <= head; from += 99_000) {
          for (const log of await read.getLogs({ address: MARKET, topics, fromBlock: from, toBlock: Math.min(head, from + 98_999) })) {
            const e = market.parseLog(log);
            if (!e) continue;
            if (e.name === "Deposited") { providers.add(String(e.args.provider).toLowerCase()); continue; }
            trades++; traders.add(String(e.args.trader).toLowerCase());
            const fee = Number(formatEther(e.args.fee));
            fees += fee;
            volume += e.name === "Bought" ? Number(formatEther(e.args.usdcIn)) : Number(formatEther(e.args.usdcOut)) + fee;
          }
        }
        if (alive) setStats({ volume, lpFees: fees * 0.8, trades, traders: traders.size, providers: providers.size });
      } catch { /* informational */ }
    };
    void load();
    const timer = window.setInterval(load, 60_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [status]);

  const value = Number(amount) || 0;
  const holding = pool?.holdings[selected] ?? 0;
  const sellShares = Math.min(value, holding);
  const estimate = !quote ? 0 : side === "buy" ? value * (1 - FEE) / (quote.price + quote.conf) : sellShares * Math.max(0, quote.price - quote.conf) * (1 - FEE);
  const lpValue = pool && pool.nav !== null && pool.totalShares > 0 ? pool.lpShares * pool.nav / pool.totalShares : null;
  const locked = pool ? pool.lockedUntil > now : false;
  const firstDeposit = pool ? pool.totalShares === 0 : false;
  const lpInput = Number(lpAmount) || 0;
  const livePrice = quote && fresh(quote) ? quote.price : shown?.price ?? null;
  const reference = shown?.reference ?? null;
  const change = livePrice !== null && reference ? livePrice - reference : null;
  const changePct = change !== null && reference ? change / reference * 100 : null;
  const capLeft = pool ? Math.max(0, Math.min(pool.caps[selected] - pool.exposure[selected], pool.balance * 0.5 - pool.openInterest)) : 0;

  async function send(kind: "trade" | "deposit" | "withdraw") {
    if (!account || !activeProvider) return connect();
    if (!onArc) { try { await ensureWalletChain(activeProvider, ARC_MAINNET); } catch (error) { setStatus(describeTxError(error)); } return; }
    setBusy(true); setStatus("Fetching the latest signed price…");
    try {
      // With no open positions the pool's value is just its USDC, so LP
      // actions need no prices and still work outside market hours.
      const needsPrices = kind === "trade" || (pool?.openInterest ?? 1) > 0;
      const bundle = needsPrices ? await fetchStockPrices(kind === "trade" ? [stock.feedId] : ALL_FEEDS) : { updates: [], prices: {} as Record<string, StockQuote> };
      const contract = new Contract(MARKET, MARKET_ABI, await new BrowserProvider(activeProvider).getSigner());
      let tx;
      if (kind === "trade") {
        const q = bundle.prices[stock.feedId.toLowerCase()];
        if (!q) throw new Error(`No fresh ${stock.symbol} price. US markets trade 09:30–16:00 New York time.`);
        if (side === "buy") {
          const minShares = value * (1 - FEE) / (q.price + q.conf) * (1 - SLIPPAGE);
          tx = await sendWithMargin(contract, "buy", [stock.id, toWei(minShares), bundle.updates], { value: toWei(value) });
        } else {
          // Selling everything uses the exact on-chain balance, not a rounded copy.
          const shares = value >= holding ? await new Contract(stock.token, ["function balanceOf(address) view returns (uint256)"], read).balanceOf(account) : toWei(sellShares);
          const minUsdc = Number(formatEther(shares)) * Math.max(0, q.price - q.conf) * (1 - FEE) * (1 - SLIPPAGE);
          tx = await sendWithMargin(contract, "sell", [stock.id, shares, toWei(minUsdc), bundle.updates]);
        }
      } else if (kind === "deposit") {
        tx = await sendWithMargin(contract, "deposit", [bundle.updates], { value: toWei(lpInput) });
      } else {
        tx = await sendWithMargin(contract, "withdraw", [await contract.sharesOf(account), bundle.updates]);
      }
      setStatus(`Submitted ${tx.hash.slice(0, 10)}… waiting for Arc`);
      await tx.wait();
      setStatus(kind === "trade" ? `${side === "buy" ? "Bought" : "Sold"} a${stock.symbol}. Confirmed on Arc Mainnet.` : kind === "deposit" ? "Deposit confirmed. You now earn 80% of trading fees." : "Withdrawal confirmed.");
      setAmount(""); setLpAmount("");
      await refresh();
    } catch (error) { setStatus(explainError(error)); }
    finally { setBusy(false); }
  }

  const noLiquidity = pool !== null && pool.balance === 0;
  const tradeDisabled = busy || !value || !open || !fresh(quote) || pool?.paused || noLiquidity || (side === "sell" && holding === 0) || (side === "buy" && pool !== null && value > pool.walletUsdc);
  const blocker = !open ? `US market closed · opens in ${countdown(nextUsOpen(new Date(clock)))} (${utcTime(nextUsOpen(new Date(clock)).getTime() / 1000)})`
    : !fresh(quote) ? "Waiting for a fresh signed price…"
    : pool?.paused ? "Market is paused."
    : noLiquidity ? "No liquidity yet. The pool needs an LP deposit before trading can start."
    : side === "buy" && pool && value > pool.walletUsdc ? "Amount is more than your USDC balance."
    : "";
  const sessionLabel = open ? "Live" : shown?.session === "pre-market" ? "Pre-market" : shown?.session === "after-hours" ? "After hours" : "Closed";

  return <main className="lend-site stocks-site">
    <nav><a href="/" className="lend-brand"><img src="/arcodian-mark.svg" alt=""/><span>ARCODIAN<small>STOCKS</small></span></a><div className="lend-nav-links"><a href="/market">Market</a><a className="active" href="/stocks">Stocks</a><a href="/lend">Lend</a><a href="/fx">FX</a></div><div className="lend-wallet"><a href="/wallet">Wallet</a><button onClick={account ? disconnect : connect}>{short(account)}</button></div></nav>

    <section className="stocks-shell">
      <header className="stocks-head">
        <div><p>STOCKS · ARC MAINNET</p><h1>Trade US stocks in USDC</h1></div>
        <div className="stocks-badges"><b className={open ? "stocks-open" : "stocks-closed"}><i/>{open ? "US market open" : `Opens in ${countdown(nextUsOpen(new Date(clock)))}`}</b><b>0.30% fee</b><b>80% of fees to LPs</b></div>
      </header>

      <div className="stocks-stats">
        <article><small>Pool liquidity</small><strong>{pool ? `${usd(pool.balance)}` : "—"}<em>USDC</em></strong></article>
        <article><small>Open interest</small><strong>{pool ? `$${usd(pool.openInterest)}` : "—"}</strong></article>
        <article><small>Volume</small><strong>{stats ? `$${usd(stats.volume)}` : "—"}</strong></article>
        <article><small>Fees earned by LPs</small><strong>{stats ? `$${usd(stats.lpFees)}` : "—"}</strong></article>
        <article><small>Trades</small><strong>{stats ? stats.trades.toLocaleString() : "—"}<em>{stats ? `${stats.traders} traders` : ""}</em></strong></article>
      </div>
      {priceError && <div className="lend-alert">Live prices unavailable: {priceError}</div>}

      <div className="stocks-terminal">
        <aside className="stocks-watch">
          <div className="stocks-watch-head"><span>Symbol</span><span>Last</span></div>
          {STOCKS.map((s) => {
            const d = display[s.feedId], q = quotes[s.feedId];
            const price = q && fresh(q) ? q.price : d?.price;
            const pct = price && d?.reference ? (price - d.reference) / d.reference * 100 : null;
            return <button key={s.id} className={s.id === selected ? "active" : ""} onClick={() => choose(s.id)}>
              <span><b>{s.symbol}</b><small>{s.name}</small></span>
              <span><strong>{price ? usd(price) : "—"}</strong>{pct !== null && <em className={pct >= 0 ? "up" : "down"}>{pct >= 0 ? "+" : ""}{pct.toFixed(2)}%</em>}</span>
              {(pool?.holdings[s.id] ?? 0) > 0 && <i>{usd(pool!.holdings[s.id], 4)} held</i>}
            </button>;
          })}
        </aside>

        <nav className="stocks-chips" aria-label="Stocks">{STOCKS.map((s) => <button key={s.id} className={s.id === selected ? "active" : ""} onClick={() => choose(s.id)}>{s.symbol}</button>)}</nav>

        <section className="stocks-chart-panel">
          <div className="stocks-quote">
            <div>
              <p>{stock.symbol} <span>· {shown?.name ?? stock.name}</span></p>
              <h2>{livePrice !== null ? `$${usd(livePrice)}` : "—"}</h2>
              {change !== null && changePct !== null && <em className={change >= 0 ? "up" : "down"}>{change >= 0 ? "+" : ""}{usd(change)} ({change >= 0 ? "+" : ""}{changePct.toFixed(2)}%) <span>{sessionLabel}</span></em>}
            </div>
            <div className="stocks-ranges">{CHART_RANGES.map((r) => <button key={r} className={r === range ? "active" : ""} onClick={() => setRange(r)}>{r}</button>)}</div>
          </div>
          <div className="stocks-chart-wrap">{candles?.length ? <StockChart candles={candles} range={range} live={livePrice} /> : <div className="stocks-chart-empty">{candles === null ? "Loading chart…" : "Chart data for this range is being prepared. Try another range or check back in a minute."}</div>}</div>
          <dl className="stocks-facts">
            <div><dt>Open</dt><dd>{shown?.open ? usd(shown.open) : "—"}</dd></div>
            <div><dt>Day range</dt><dd>{shown?.low && shown?.high ? `${usd(shown.low)} – ${usd(shown.high)}` : "—"}</dd></div>
            <div><dt>52-week range</dt><dd>{shown?.yearLow && shown?.yearHigh ? `${usd(shown.yearLow)} – ${usd(shown.yearHigh)}` : "—"}</dd></div>
            <div><dt>Volume</dt><dd>{shown?.volume || "—"}</dd></div>
            <div><dt>Market cap</dt><dd>{shown?.marketCap ?? "—"}</dd></div>
            <div><dt>P/E</dt><dd>{shown?.pe ?? "—"}</dd></div>
          </dl>
        </section>

        <article className="stocks-trade">
          <div className="stocks-side"><button className={side === "buy" ? "active buy" : ""} onClick={() => { setSide("buy"); setAmount(""); }}>Buy</button><button className={side === "sell" ? "active sell" : ""} onClick={() => { setSide("sell"); setAmount(""); }}>Sell</button></div>
          <div className="stocks-bidask"><span>Buy at<b>{quote && fresh(quote) ? `$${usd(quote.price + quote.conf)}` : "—"}</b></span><span>Sell at<b>{quote && fresh(quote) ? `$${usd(Math.max(0, quote.price - quote.conf))}` : "—"}</b></span></div>
          <label>{side === "buy" ? "You pay" : "You sell"}<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.00"/><b>{side === "buy" ? "USDC" : `a${stock.symbol}`}</b></label>
          <div className="stocks-balance">
            <span>{!account ? "Connect a wallet to trade" : side === "buy" ? `Balance ${pool ? usd(pool.walletUsdc, 4) : "—"} USDC` : `Holding ${usd(holding, 6)} a${stock.symbol}`}</span>
            {side === "buy" && pool && pool.walletUsdc > GAS_RESERVE && <button onClick={() => setAmount(String(Math.floor((Math.min(pool.walletUsdc - GAS_RESERVE, capLeft || Infinity)) * 1e4) / 1e4))}>Max</button>}
            {side === "sell" && holding > 0 && <button onClick={() => setAmount(String(holding))}>Max</button>}
          </div>
          <dl className="stocks-receipt">
            <div><dt>You receive</dt><dd>{value > 0 && quote ? (side === "buy" ? `≈ ${usd(estimate, 6)} a${stock.symbol}` : `≈ ${usd(estimate, 4)} USDC`) : "—"}</dd></div>
            <div><dt>Fee (0.30%)</dt><dd>{value > 0 && quote ? `${usd(side === "buy" ? value * FEE : sellShares * quote.price * FEE, 4)} USDC` : "—"}</dd></div>
            <div><dt>Max slippage</dt><dd>1%</dd></div>
            <div><dt>Room left</dt><dd>{pool ? `${usd(capLeft)} USDC` : "—"}</dd></div>
          </dl>
          {!account ? <button className="stocks-cta" onClick={connect}>Connect wallet</button>
            : !onArc ? <button className="stocks-cta" onClick={() => void send("trade")}>Switch to Arc Mainnet</button>
            : <button className={`stocks-cta ${side}`} disabled={tradeDisabled} onClick={() => void send("trade")}>{busy ? "Waiting for wallet…" : side === "buy" ? `Buy a${stock.symbol}` : `Sell a${stock.symbol}`}</button>}
          {blocker && <em className="stocks-blocker">{blocker}</em>}
          {status && <p className="stocks-status">{status}</p>}
        </article>
      </div>

      <div className="lend-actions stocks-lower">
        <article><p>EARN</p><h2>Provide liquidity</h2>
          <span className="stocks-note">Deposit USDC into the pool that pays traders. LPs earn <b>80% of every 0.30% trade fee</b>, and the pool keeps what traders lose, while paying out what they win. Anyone can deposit, and withdraw 15 minutes after depositing.</span>
          <div className="stocks-lp-figures"><div><small>Your position</small><b>{lpValue !== null ? `${usd(lpValue, 4)} USDC` : pool && pool.lpShares > 0 ? `${usd(pool.lpShares, 4)} shares` : "—"}</b></div><div><small>Your pool share</small><b>{pool && pool.totalShares > 0 ? `${usd(pool.lpShares / pool.totalShares * 100)}%` : "—"}</b></div><div><small>LPs</small><b>{stats ? stats.providers : "—"}</b></div></div>
          <label>Deposit<input inputMode="decimal" value={lpAmount} onChange={(e) => setLpAmount(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.00"/><b>USDC</b></label>
          <small>{firstDeposit ? `The first deposit must be at least ${MIN_FIRST_DEPOSIT} USDC. ` : ""}{locked && pool ? `Unlocks ${utcTime(pool.lockedUntil)}.` : ""}</small>
          <div><button disabled={busy || !lpInput || (firstDeposit && lpInput < MIN_FIRST_DEPOSIT) || pool?.paused} onClick={() => void send("deposit")}>Deposit</button><button disabled={busy || !pool?.lpShares || locked} onClick={() => void send("withdraw")}>Withdraw all</button></div></article>
        <article><p>PRICES</p><h2>How prices work</h2>
          <span className="stocks-note">Arcodian&apos;s price service reads every stock from two independent market-data sources, CNBC and Nasdaq, every 5 seconds, and signs the price only when both are fresh and within 0.5% of each other. Each trade carries that signed price on-chain. The contract refuses prices older than 60 seconds or with a band wider than 1%. Buys fill at the top of the band and sells at the bottom. Nothing is signed outside US market hours, so trading follows the US session: 13:30–20:00 UTC (14:30–21:00 UTC while the US is on standard time).</span></article>
      </div>
    </section>

    <section className="lend-risk stocks-risk"><p>RISK</p><h2>Read this before you trade.</h2><div>
      <article><b>Price tracking, not ownership</b><span>Tokens follow the stock price only. They carry no ownership, votes or dividends and cannot be redeemed for the stock itself.</span></article>
      <article><b>Pool-backed payouts</b><span>Winnings are paid from LP liquidity. Caps keep open interest at or below half the pool; if the pool ran dry, sells would fail until liquidity returned.</span></article>
      <article><b>Price oracle</b><span>Prices are signed by Arcodian&apos;s price service. That key is the trust point: per-stock caps and the 50%-of-pool limit bound what a bad price could cost the pool.</span></article>
      <article><b>Not audited</b><span>The contracts are source-verified and tested but have not had an external audit. Caps are small for that reason.</span></article>
    </div></section>
    <footer><span>Arcodian Stocks · Arc Mainnet</span><a href={`${ARC_MAINNET.explorer}/address/${MARKET}?tab=contract`} target="_blank" rel="noreferrer">View verified contract →</a></footer>
  </main>;
}

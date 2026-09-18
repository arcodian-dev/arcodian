import { useCallback, useEffect, useState } from "react";
import { BrowserProvider, Contract, JsonRpcProvider, formatEther, parseEther } from "ethers";
import { ARC_MAINNET, ARC_MAINNET_CONTRACTS } from "../config";
import { ensureWalletChain } from "../shared";
import { STOCKS, fetchPyth, usMarketOpen, type PythQuote } from "../stocks";
import { describeTxError } from "../txError";
import "./LendApp.css";
import "./StocksApp.css";

type Props = { account: string; chainId: number | null; activeProvider: EthereumProvider | null; connect: () => void; disconnect: () => void };
type Pool = { balance: number; openInterest: number; lpShares: number; totalShares: number; lockedUntil: number; nav: number | null; holdings: number[]; caps: number[]; exposure: number[]; paused: boolean };

const MARKET = ARC_MAINNET_CONTRACTS.arcStockMarket;
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
];
const TOKEN_ABI = ["function balanceOf(address) view returns (uint256)"];
const FEE = 0.003;
const SLIPPAGE = 0.01;
const ALL_FEEDS = STOCKS.map((s) => s.feedId);
const short = (value: string) => value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "Connect wallet";
const usd = (value: number, digits = 2) => value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
const toWei = (value: number) => parseEther(value.toFixed(18).replace(/\.?0+$/, "") || "0");

export default function StocksApp({ account, chainId, activeProvider, connect, disconnect }: Props) {
  const [quotes, setQuotes] = useState<Record<string, PythQuote>>({});
  const [priceError, setPriceError] = useState("");
  const [selected, setSelected] = useState(0);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [lpAmount, setLpAmount] = useState("");
  const [pool, setPool] = useState<Pool | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(usMarketOpen());
  const live = Boolean(MARKET);
  const onArc = chainId === ARC_MAINNET.id;
  const stock = STOCKS[selected];
  const quote = quotes[stock.feedId];
  const now = Math.floor(Date.now() / 1000);
  const fresh = (q?: PythQuote) => Boolean(q && now - q.publishTime <= 45);

  // Prices: Pyth's latest reports through our proxy, every 5 seconds.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      setOpen(usMarketOpen());
      try {
        const bundle = await fetchPyth(ALL_FEEDS);
        if (alive) { setQuotes(bundle.prices); setPriceError(""); }
      } catch (error) { if (alive) setPriceError(error instanceof Error ? error.message : "Price service unavailable"); }
    };
    void load();
    const timer = window.setInterval(load, 5_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  const refresh = useCallback(async () => {
    if (!live) return;
    try {
      const market = new Contract(MARKET, MARKET_ABI, read);
      const [balance, oi, totalShares, paused] = await Promise.all([market.poolBalance(), market.totalOpenInterest(), market.totalShares(), market.paused()]);
      const assets = [];
      for (const s of STOCKS) assets.push(await market.assets(s.id));
      const caps = assets.map((a) => Number(formatEther(a.maxOpenInterest)));
      const exposure = [];
      for (const s of STOCKS) exposure.push(Number(formatEther(await market.openInterest(s.id))));
      let nav: number | null = null;
      try { nav = Number(formatEther(await market.netAssetValue())); } catch { nav = null; } // stale prices outside market hours
      let lpShares = 0, lockedUntil = 0;
      const holdings = STOCKS.map(() => 0);
      if (account) {
        lpShares = Number(formatEther(await market.sharesOf(account)));
        lockedUntil = Number(await market.lockedUntil(account));
        for (const s of STOCKS) holdings[s.id] = Number(formatEther(await new Contract(assets[s.id].token, TOKEN_ABI, read).balanceOf(account)));
      }
      setPool({ balance: Number(formatEther(balance)), openInterest: Number(formatEther(oi)), totalShares: Number(formatEther(totalShares)), lpShares, lockedUntil, nav, holdings, caps, exposure, paused });
    } catch { /* keep the last snapshot; prices and trading still work */ }
  }, [account, live]);

  useEffect(() => { void refresh(); const timer = window.setInterval(refresh, 30_000); return () => window.clearInterval(timer); }, [refresh]);

  const value = Number(amount) || 0;
  const estimate = !quote ? 0 : side === "buy"
    ? value * (1 - FEE) / (quote.price + quote.conf)
    : value * Math.max(0, quote.price - quote.conf) * (1 - FEE);
  const holding = pool?.holdings[selected] ?? 0;
  const lpValue = pool && pool.nav !== null && pool.totalShares > 0 ? pool.lpShares * pool.nav / pool.totalShares : null;
  const locked = pool ? pool.lockedUntil > now : false;

  async function send(kind: "trade" | "deposit" | "withdraw") {
    if (!account || !activeProvider) return connect();
    if (!onArc) { try { await ensureWalletChain(activeProvider, ARC_MAINNET); } catch (error) { setStatus(describeTxError(error)); } return; }
    setBusy(true); setStatus("Fetching the latest signed prices…");
    try {
      // Trades carry the traded stock's update; LP actions price the whole
      // book, so they carry every feed.
      const bundle = await fetchPyth(kind === "trade" ? [stock.feedId] : ALL_FEEDS);
      const signer = await new BrowserProvider(activeProvider).getSigner();
      const market = new Contract(MARKET, MARKET_ABI, signer);
      let tx;
      if (kind === "trade") {
        const q = bundle.prices[stock.feedId.toLowerCase()];
        if (!q) throw new Error(`No fresh ${stock.symbol} price. US markets trade 09:30–16:00 New York time.`);
        if (side === "buy") {
          const minShares = value * (1 - FEE) / (q.price + q.conf) * (1 - SLIPPAGE);
          tx = await market.buy(stock.id, toWei(minShares), bundle.updates, { value: toWei(value) });
        } else {
          const minUsdc = value * Math.max(0, q.price - q.conf) * (1 - FEE) * (1 - SLIPPAGE);
          const shares = value >= holding ? toWei(holding) : toWei(value);
          tx = await market.sell(stock.id, shares, toWei(minUsdc), bundle.updates);
        }
      } else if (kind === "deposit") {
        tx = await market.deposit(bundle.updates, { value: toWei(Number(lpAmount)) });
      } else {
        const shares = await market.sharesOf(account);
        tx = await market.withdraw(shares, bundle.updates);
      }
      setStatus(`Submitted ${tx.hash.slice(0, 10)}…`);
      await tx.wait();
      setStatus("Confirmed on Arc Mainnet."); setAmount(""); setLpAmount("");
      await refresh();
    } catch (error) { setStatus(error instanceof Error && !("code" in error) ? error.message : describeTxError(error)); }
    finally { setBusy(false); }
  }

  const tradeDisabled = !live || busy || !value || !open || !fresh(quote) || pool?.paused || (side === "sell" && holding === 0);
  const blocker = !live ? "Launching soon — the market contract is not deployed yet." : !open ? "US markets are closed. Trading reopens 09:30 New York time, Monday to Friday." : !fresh(quote) ? "Waiting for a fresh price." : pool?.paused ? "Market is paused." : "";

  return <main className="lend-site stocks-site">
    <nav><a href="/" className="lend-brand"><img src="/arcodian-mark.svg" alt=""/><span>ARCODIAN<small>STOCKS</small></span></a><div className="lend-nav-links"><a href="/market">Market</a><a className="active" href="/stocks">Stocks</a><a href="/lend">Lend</a><a href="/fx">FX</a></div><div className="lend-wallet"><a href="/wallet">Wallet</a><button onClick={account ? disconnect : connect}>{short(account)}</button></div></nav>
    <header><p>SYNTHETIC STOCKS · ARC MAINNET</p><h1>US stock prices.<br/>Settled in USDC on Arc.</h1><span>Buy and sell synthetic shares that track NVIDIA, Apple, Tesla and seven more at Pyth&apos;s live price. You never hold the real stock: a synthetic share is a claim on the USDC pool, paid out at the market price when you sell.</span><div className="lend-badges"><b className={open ? "stocks-open" : "stocks-closed"}>{open ? "US MARKET OPEN" : "US MARKET CLOSED"}</b><b>0.30% PER TRADE</b><b>80% OF FEES TO LPS</b><b>PYTH PRICED</b></div></header>

    <section className="lend-terminal">
      <div className="lend-overview lend-totals"><article><small>POOL LIQUIDITY</small><strong>{pool ? `${usd(pool.balance)} USDC` : "—"}</strong><em>backs every payout</em></article><article><small>OPEN INTEREST</small><strong>{pool ? `$${usd(pool.openInterest)}` : "—"}</strong><em>capped at 50% of the pool</em></article><article><small>LP VALUE</small><strong>{pool?.nav != null ? `${usd(pool.nav)} USDC` : "—"}</strong><em>pool minus what traders are owed</em></article><article><small>STOCKS LISTED</small><strong>{STOCKS.length}</strong><em>Pyth US equity feeds</em></article></div>
      {priceError && <div className="lend-alert">Live prices unavailable: {priceError}</div>}

      <div className="stocks-board">
        <div className="stocks-list">{STOCKS.map((s) => { const q = quotes[s.feedId]; return <button key={s.id} className={s.id === selected ? "active" : ""} onClick={() => { setSelected(s.id); setAmount(""); }}>
          <b>{s.symbol}</b><small>{s.name}</small><strong>{q ? `$${usd(q.price)}` : "—"}</strong><em className={fresh(q) ? "live" : ""}>{q ? (fresh(q) ? "live" : "last close") : ""}</em>
          {pool && (pool.holdings[s.id] ?? 0) > 0 && <i>{usd(pool.holdings[s.id], 4)} held</i>}
        </button>; })}</div>

        <article className="stocks-trade">
          <p>s{stock.symbol} · SYNTHETIC {stock.name.toUpperCase()}</p>
          <h2>{quote ? `$${usd(quote.price)}` : "—"}</h2>
          <small>{quote ? `Buy at $${usd(quote.price + quote.conf)} · sell at $${usd(Math.max(0, quote.price - quote.conf))} (Pyth confidence band)` : "No price yet"}</small>
          <div className="stocks-side"><button className={side === "buy" ? "active" : ""} onClick={() => { setSide("buy"); setAmount(""); }}>Buy</button><button className={side === "sell" ? "active" : ""} onClick={() => { setSide("sell"); setAmount(""); }}>Sell</button></div>
          <label>{side === "buy" ? "Pay" : "Sell"}<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.00"/><b>{side === "buy" ? "USDC" : `s${stock.symbol}`}</b></label>
          {side === "sell" && holding > 0 && <button className="lend-inline" onClick={() => setAmount(String(holding))}>Max {usd(holding, 6)}</button>}
          <small>{value > 0 && quote ? (side === "buy" ? `≈ ${usd(estimate, 6)} s${stock.symbol}` : `≈ ${usd(estimate)} USDC`) + ` after the 0.30% fee · ${SLIPPAGE * 100}% max slippage` : `You hold ${usd(holding, 6)} s${stock.symbol}`}</small>
          {pool && <small>Open interest {usd(pool.exposure[selected])} / {usd(pool.caps[selected], 0)} USD cap</small>}
          {!account ? <button onClick={connect}>Connect wallet</button> : <button disabled={tradeDisabled} onClick={() => send("trade")}>{!onArc ? "Switch to Arc Mainnet" : side === "buy" ? `Buy s${stock.symbol}` : `Sell s${stock.symbol}`}</button>}
          {blocker && <em className="stocks-blocker">{blocker}</em>}
        </article>
      </div>

      <div className="lend-actions">
        <article><p>LIQUIDITY</p><h2>Be the house</h2>
          <span className="stocks-note">LPs fund the pool that pays traders. You earn 80% of every trade fee and take the other side of traders&apos; positions: when traders win, LP value falls; when they lose, it rises. Deposits lock for 24 hours. Deposits and withdrawals need fresh prices, so they work during US market hours.</span>
          <label>Deposit<input inputMode="decimal" value={lpAmount} onChange={(e) => setLpAmount(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.00"/><b>USDC</b></label>
          <small>Your LP position {lpValue !== null ? `${usd(lpValue, 4)} USDC` : pool && pool.lpShares > 0 ? `${usd(pool.lpShares, 4)} shares` : "none"}{locked && pool ? ` · unlocks ${new Date(pool.lockedUntil * 1000).toLocaleString()}` : ""}</small>
          <div><button disabled={!live || busy || !Number(lpAmount) || pool?.paused} onClick={() => send("deposit")}>Deposit</button><button disabled={!live || busy || !pool?.lpShares || locked} onClick={() => send("withdraw")}>Withdraw all</button></div></article>
        <article><p>HOW PRICES WORK</p><h2>One signed price per trade</h2>
          <span className="stocks-note">Each trade fetches Pyth&apos;s latest signed report for the stock and posts it on-chain in the same transaction. The contract refuses prices older than 60 seconds or with a confidence band wider than 1%, fills buys at the top of the band and sells at the bottom, and charges 0.30%. Outside US market hours the feeds stop, so trading stops too.</span></article>
      </div>
      {status && <p className="lend-status">{status}</p>}
    </section>

    <section className="lend-risk"><p>RISK</p><h2>Read this before you trade.</h2><div>
      <article><b>Not real shares</b><span>Synthetic shares carry no ownership, votes or dividends and cannot be redeemed for stock. They are a USDC claim on this pool at the Pyth price.</span></article>
      <article><b>Pool-backed payouts</b><span>Winnings are paid from LP liquidity. Caps keep open interest at or below half the pool, but if the pool ran dry, sells would fail until liquidity returned.</span></article>
      <article><b>Not audited</b><span>The contract is source-verified and tested but has not had an external audit. Per-stock caps are small for that reason.</span></article>
    </div></section>
    <footer><span>Arcodian Stocks · Arc Mainnet · priced by Pyth</span>{live ? <a href={`${ARC_MAINNET.explorer}/address/${MARKET}?tab=contract`} target="_blank" rel="noreferrer">View verified contract →</a> : <span>Contract launching soon</span>}</footer>
  </main>;
}

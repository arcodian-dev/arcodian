import { useEffect, useMemo, useState } from "react";
import { formatEther, formatUnits } from "ethers";
import { imageUrl } from "../shared";
import { navHref } from "../config";

/**
 * Landing built from the "Arcodian Landing" design study.
 *
 * The design's visual language is adopted wholesale — orbit hero, mono
 * numerals, pill tabs, card grid, accordion. Its *data* is not: the study
 * shipped invented coins and a $184.6M TVL under a "LIVE" badge.
 *
 * Small numbers are shown as they are. A testnet that admits to eleven trades
 * is worth more than one that implies eleven thousand.
 *
 * The launchpad radar/ticker/table below reads Arc MAINNET launches from
 * /data/mainnet-market-index.json (a server-side indexer, see
 * scripts/mainnet-market-index.mjs) — not the Arc Testnet static index, and
 * not a live per-page RPC scan (that drew sustained 429s from the shared
 * free-tier RPC once there was real traffic, 2026-07-31). If it looks
 * empty, that's real: check the indexer's systemd timer before assuming a
 * bug. The separate mainnet bridge strip reads /data/bridge-stats.json (real
 * ArcBridgeRouter events across all 5 chains). Both are genuinely mainnet
 * now — don't reintroduce a testnet data source here without badging it.
 */

type Trade = { side: string; native: string; tokens: string; timestamp?: number };

type Launch = {
  address: string;
  symbol: string;
  name: string;
  image: string;
  currency: string;
  reserve: bigint;
  threshold: bigint;
  volume: bigint;
  volume24h: bigint;
  globalPool: boolean;
  holderCount: number;
  tradeCount: number;
  graduated: boolean;
  progress: number;
  spark: string;
};

type Totals = { coins: number; trades: number; holders: number; volume: number; graduated: number };

const RAILS = [
  {
    tab: "screener", key: "market", label: "Market", tag: "DISCOVER",
    title: "Every Arc coin on one radar",
    desc: "Watch curves fill in real time. Creator, contract, holders, tape and graduation progress all sit in the same room — before anyone has to trust anything.",
    bullets: ["Live curve and tape per coin", "Creator and contract always visible", "Graduation progress from public reserve"],
    cta: "Open Market",
  },
  {
    tab: "swap", key: "swap", label: "Swap", tag: "TRADE",
    title: "Trade any Arc token",
    desc: "Permissionless pools on Arc. Paste a contract address to trade it — the address is the only identity that matters, and the price impact is shown before you sign.",
    bullets: ["Two fee tiers, quoted by real output", "Thin-pool warning before signing", "Non-custodial, settled on Arc"],
    cta: "Open Swap",
  },
  {
    tab: "bridge", key: "bridge", label: "Bridge", tag: "MOVE",
    title: "Carry USDC in and out",
    desc: "Official Circle CCTP rails — burn on the source chain, attestation, mint on the destination. No custom bridge contract holding your funds in the middle.",
    bullets: ["Circle CCTP, not a custom bridge", "Every route starts or ends on Arc", "Burn, attest, mint — each step visible"],
    cta: "Open Bridge",
  },
  {
    tab: "fx", key: "fx", label: "FX", tag: "STABLE",
    title: "USDC ⇄ EURC at one rate",
    desc: "A permissionless on-chain pool between the two Circle stablecoins on Arc. No aggregator hop, no owner withdrawal — a provider's only exit is their own share.",
    bullets: ["One on-chain rate, no aggregator", "Anyone may add liquidity", "Fees compound into the pool"],
    cta: "Open FX",
  },
] as const;

const PILLARS: { group: string; blurb: string; items: { name: string; desc: string; tab?: string; href?: string }[] }[] = [
  {
    group: "Money", blurb: "A non-custodial home for USDC and EURC.",
    items: [
      { name: "Wallet", desc: "Self-custody USDC + EURC on Arc. No keys held, no custody taken.", href: "https://wallet.arcodian.fun/" },
      { name: "Pay", desc: "Exact-value invoices that settle once, with a 0.30% fee taken atomically.", tab: "arcpay" },
      { name: "Swap", desc: "Trade any Arc token on the canonical AMM.", tab: "swap" },
      { name: "Bridge", desc: "Move USDC in and out over official Circle CCTP — no bridge holding your funds.", tab: "bridge" },
      { name: "Stablecoin FX", desc: "Convert USDC ⇄ EURC at one transparent rate.", tab: "fx" },
    ],
  },
  {
    group: "Market", blurb: "Discover, launch, and put idle USDC to work.",
    items: [
      { name: "Markets", desc: "Every Arc coin on one live radar with price, holders, and graduation.", tab: "screener" },
      { name: "Launchpad", desc: "Deploy a coin in minutes on a readable bonding curve — liquidity burns at graduation.", tab: "screener" },
      { name: "Lend", desc: "Isolated USDC market: supply to earn, or borrow against EURC up to 70% LTV.", href: "https://lend.arcodian.fun/" },
    ],
  },
  {
    group: "Agent economy", blurb: "Give software money with limits, not a blank check.",
    items: [
      { name: "Agent Passport", desc: "ERC-8004 identity bound to an authorized wallet. Identity never grants spend by itself.", tab: "developers" },
      { name: "Agent Pay", desc: "One isolated vault per owner with per-payment, daily, expiry, and merchant limits.", tab: "agentpay" },
      { name: "Jobs", desc: "Outcome escrow settled in USDC only when a job is verifiably completed.", tab: "jobs" },
      { name: "Reputation", desc: "Objective, evidence-backed scores from real completed jobs and independent validation.", tab: "jobs" },
      { name: "Arcodian MCP", desc: "Agents read state and get unsigned transactions to sign — the server never holds a key.", href: "https://arcodian.fun/mcp" },
      { name: "Scoped delegation", desc: "Session-key and timelock spikes that enforce capability, amount, time, and revocation on-chain.", tab: "contracts" },
    ],
  },
  {
    group: "Build & trust", blurb: "Everything is a public contract you can verify.",
    items: [
      { name: "Developers", desc: "SDK, machine-readable registry, event schemas, and the MCP endpoint.", tab: "developers" },
      { name: "Trust Center", desc: "Every canonical address with a live on-chain wiring proof.", tab: "contracts" },
      { name: "Analytics", desc: "Public protocol metrics read straight from chain.", tab: "analytics" },
      { name: "Treasury", desc: "Where protocol fees go, in the open.", tab: "treasury" },
    ],
  },
];

const STEPS = [
  { n: "01", title: "Discover", desc: "New coins surface the moment they launch. Price discovery starts in the open, on a curve anyone can read." },
  { n: "02", title: "Launch", desc: "Deploy in minutes with no hidden allocation. Supply and distribution are verifiable from the first block." },
  { n: "03", title: "Graduate", desc: "At the threshold, liquidity moves into a public pool and LP ownership is burned. Nobody can pull it back." },
];

const FAQS = [
  { q: "What is Arc?", a: "Arc is Circle's network, where USDC is the gas token itself. Arcodian is the interface for discovering, launching and trading assets on it. Bridge and the USDC-only Market/Launchpad are live on Arc Mainnet with real USDC. Swap (via Circle's App Kit SDK), Stablecoin FX, Lend, and the agent-economy rails are still Arc Testnet only." },
  { q: "Is Arcodian custodial?", a: "No. You connect your own wallet and every action settles directly on chain. Arcodian never holds your assets and has no ability to move them." },
  { q: "What does graduation actually do?", a: "When a curve reaches its threshold, its liquidity is moved into a public pool and the LP tokens are sent to a dead address. The liquidity stays tradable forever; the right to withdraw it is destroyed." },
  { q: "Who can create a pool?", a: "Anyone. The pair factory is permissionless — any two tokens, at either fee tier. The one exception is a launchpad coin still on its curve: only that coin's own curve may open its pair, so graduation liquidity cannot be front-run." },
  { q: "Are these real numbers?", a: "Yes. The radar and table below read Arc Mainnet's launch factory live from chain — if it looks empty, that's because it is: nobody has launched a mainnet coin yet, not a bug or a placeholder. The Bridge figures higher on this page are also read live from the deployed Arc Mainnet contracts. Nothing here is illustrative or filled in." },
];

function sparkFrom(trades: Trade[]): string {
  const prices = trades
    .filter((t) => t.native && t.tokens && BigInt(t.tokens) > 0n)
    .map((t) => Number(BigInt(t.native) * 1_000_000n / BigInt(t.tokens)));
  if (prices.length < 2) return "";
  const min = Math.min(...prices), max = Math.max(...prices), range = max - min || 1;
  return prices
    .map((p, i) => `${((i / (prices.length - 1)) * 120).toFixed(1)},${(32 - ((p - min) / range) * 30).toFixed(1)}`)
    .join(" ");
}

/** Quote amounts are 18-dec for USDC-native curves and 6-dec for EURC ones. */
function quoteAmount(value: bigint, currency: string, globalPool = false): number {
  return Number(globalPool || currency === "EURC" ? formatUnits(value, 6) : formatEther(value));
}

function money(value: number, currency: string): string {
  const symbol = currency === "EURC" ? "€" : "$";
  return `${symbol}${value.toLocaleString(undefined, { maximumFractionDigits: value < 1 ? 4 : 2 })}`;
}

export default function LandingExperience({ enterMarket, chooseCoin, openTab }: {
  enterMarket: () => void;
  chooseCoin: (address: string) => void;
  openTab: (tab: string) => void;
}) {
  const host = typeof window !== "undefined" ? window.location.hostname : "";
  const [launches, setLaunches] = useState<Launch[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [failed, setFailed] = useState(false);
  const [rail, setRail] = useState<string>("market");
  const [showAllMarkets, setShowAllMarkets] = useState(false);
  const [openFaq, setOpenFaq] = useState(0);
  const [bridgeStats, setBridgeStats] = useState<{ outOfArc: { grossUsd: number; txCount: number }; intoArc: { grossUsd: number; txCount: number }; totalFeeUsd: number; totalTxCount: number } | null>(null);

  useEffect(() => {
    // Real Arc Mainnet activity — server-side snapshot (arcodian-bridge-stats.timer,
    // every 5 min) reading all 5 deployed ArcBridgeRouter contracts directly.
    // Separate from the testnet market index below: this is the one section
    // of the landing page that is genuinely mainnet, not testnet.
    let alive = true;
    fetch("/data/bridge-stats.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (alive && data) setBridgeStats(data); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    // The landing radar reads the same server-side mainnet-market-index.json
    // the Market/TradingDesk pages read (added 2026-07-31). This used to
    // scan every launch's full Bought/Sold history live from the browser on
    // every page load — harmless alone, but combined with Market doing the
    // same thing it drew sustained HTTP 429s from the shared free-tier Arc
    // Mainnet RPC (holders/trades/live tape showing "temporarily offline"
    // even though the chain itself was fine). One indexer on a 30s timer
    // now does that scanning once for everyone; the browser just fetches
    // the result. holderCount is unique buyer+seller addresses (a real
    // proxy, not the exact current holder count — a wallet that fully exits
    // still counts once — there's no way to get a precise live holder count
    // without indexing every transfer, and this is honest about being "who
    // has traded it" rather than faking precision).
    let alive = true;
    (async () => {
      const response = await fetch("/data/mainnet-market-index.json", { cache: "no-cache" });
      if (!response.ok) throw new Error("INDEX_UNAVAILABLE");
      const index = await response.json() as {
        launches?: Array<{
          address: string; symbol: string; name: string; image: string;
          reserve: string; threshold: string; graduated: boolean;
          volume: string; tradeCount: number; holderCount: number;
          globalPool?: boolean;
          trades?: Array<{ native: string; tokens: string }>;
        }>;
      };
      const rows = (index.launches || []).map((item) => {
        const reserve = BigInt(item.reserve), threshold = BigInt(item.threshold || "1");
        return {
          address: item.address, symbol: item.symbol, name: item.name, image: item.image, currency: "USDC",
          reserve, threshold, volume: BigInt(item.volume || "0"), volume24h: 0n,
          globalPool: Boolean(item.globalPool),
          holderCount: item.holderCount, tradeCount: item.tradeCount,
          graduated: item.graduated, progress: item.graduated ? 100 : Number(reserve * 10_000n / (threshold || 1n)) / 100,
          spark: sparkFrom((item.trades || []).map((trade) => ({ side: "buy", native: trade.native, tokens: trade.tokens }))),
        };
      });
      if (!alive) return;
      setLaunches(rows.reverse());
      setTotals({
        coins: rows.length,
        trades: rows.reduce((sum, row) => sum + row.tradeCount, 0),
        holders: rows.reduce((sum, row) => sum + row.holderCount, 0),
        volume: rows.reduce((sum, row) => sum + quoteAmount(row.volume, row.currency, row.globalPool), 0),
        graduated: rows.filter((row) => row.graduated).length,
      });
    })().catch(() => { if (alive) { setFailed(true); setLaunches([]); } });
    return () => { alive = false; };
  }, []);

  // Busiest first, so the radar leads with whatever actually has a tape.
  const ranked = useMemo(
    () => [...launches].sort((a, b) => {
      const av = quoteAmount(a.volume, a.currency, a.globalPool);
      const bv = quoteAmount(b.volume, b.currency, b.globalPool);
      return bv - av || b.tradeCount - a.tradeCount;
    }),
    [launches],
  );
  const visibleLiveMarkets = showAllMarkets ? ranked : ranked.slice(0, 5);
  const active = RAILS.find((item) => item.key === rail) || RAILS[0];
  const activeHref = navHref(active.tab, host);

  const statTiles = totals ? [
    { value: String(totals.coins), label: "Coins launched" },
    { value: String(totals.trades), label: "Trades settled" },
    { value: money(totals.volume, "USDC"), label: "Volume, all time" },
    { value: String(totals.holders), label: "Holders" },
  ] : [];

  function openRail(tab: string) {
    const href = navHref(tab, host);
    if (href) { window.open(href, "_blank", "noreferrer"); return; }
    if (tab === "screener") enterMarket(); else openTab(tab);
  }

  return <div className="lp lp-embedded">

    {ranked.length > 0 && (
      <div className="lp-ticker" aria-hidden="true">
        <div className="lp-ticker-track">
          {[0, 1].map((copy) => (
            <div className="lp-ticker-run" key={copy}>
              {ranked.map((row) => (
                <span key={`${copy}-${row.address}`}>
                  <b>{row.symbol}</b>
                  <small>{money(quoteAmount(row.volume, row.currency, row.globalPool), row.currency)}</small>
                  <em>{row.progress.toFixed(1)}%</em>
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    )}

    {bridgeStats && (
      <section className="lp-mainnet-strip">
        <p className="lp-mainnet-badge">● LIVE ON ARC MAINNET</p>
        <div className="lp-stats">
          <div><b>${bridgeStats.outOfArc.grossUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}</b><small>Bridged out of Arc</small></div>
          <div><b>${bridgeStats.intoArc.grossUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}</b><small>Bridged into Arc</small></div>
          <div><b>{bridgeStats.totalTxCount}</b><small>Bridge transactions</small></div>
          <div><b>${bridgeStats.totalFeeUsd.toFixed(4)}</b><small>Protocol fees collected</small></div>
        </div>
      </section>
    )}

    {totals && (
      <section className="lp-stats-wrap">
        <p className="lp-mainnet-badge">● ARC MAINNET RADAR</p>
        <section className="lp-stats">
          {statTiles.map((tile) => (
            <div key={tile.label}><b>{tile.value}</b><small>{tile.label}</small></div>
          ))}
        </section>
      </section>
    )}

    <section className="lp-section">
      <p className="lp-kicker">/ How Arcodian works</p>
      <h2>From launch to liquidity in three moves.</h2>
      <div className="lp-steps">
        {STEPS.map((step) => (
          <article key={step.n}>
            <span>{step.n}</span>
            <h3>{step.title}</h3>
            <p>{step.desc}</p>
          </article>
        ))}
      </div>
    </section>

    <section className="lp-section">
      <p className="lp-kicker">/ The console</p>
      <h2>Four rails. One economy.</h2>
      <div className="lp-tabs">
        {RAILS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={rail === item.key ? "active" : ""}
            onClick={() => setRail(item.key)}
          >{item.label}</button>
        ))}
      </div>
      <div className="lp-rail-panel">
        <div>
          <span className="lp-tag">{active.tag}</span>
          <h3>{active.title}</h3>
          <p>{active.desc}</p>
          <ul>
            {active.bullets.map((bullet) => (
              <li key={bullet}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path d="M20 6L9 17l-5-5" /></svg>
                <span>{bullet}</span>
              </li>
            ))}
          </ul>
          {activeHref ? (
            <a className="lp-btn-primary" href={activeHref} target="_blank" rel="noreferrer">{active.cta} <span aria-hidden="true">→</span></a>
          ) : (
            <button type="button" className="lp-btn-primary" onClick={() => openRail(active.tab)}>{active.cta} <span aria-hidden="true">→</span></button>
          )}
        </div>
        <div className="lp-rail-preview">
          <div className="lp-preview-head">
            <span>{active.key === "market" ? "BUSIEST NOW" : active.tag}</span>
            <span className={active.key === "bridge" || active.key === "market" ? "lp-live" : "lp-live lp-live-testnet"}>
              {active.key === "bridge" || active.key === "market" ? "● ARC MAINNET" : "● TESTNET"}
            </span>
          </div>
          {active.key === "market" ? (
            ranked.slice(0, 4).map((row) => (
              <button type="button" key={row.address} className="lp-mini" onClick={() => chooseCoin(row.address)}>
                <span className="lp-avatar">{row.image ? <img src={imageUrl(row.image)} alt="" /> : row.symbol[0]}</span>
                <span className="lp-mini-id"><b>{row.symbol}</b><small>{row.name}</small></span>
                {row.spark
                  ? <svg viewBox="0 0 120 34" aria-hidden="true"><polyline points={row.spark} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  : <span className="lp-nospark">{row.tradeCount} confirmed trade{row.tradeCount === 1 ? "" : "s"}</span>}
                <span className="lp-mini-num"><b>{money(quoteAmount(row.volume, row.currency, row.globalPool), row.currency)}</b><small>{row.progress.toFixed(1)}%</small></span>
              </button>
            ))
          ) : (
            <ul className="lp-preview-facts">
              {active.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}
            </ul>
          )}
          {active.key === "market" && ranked.length === 0 && (
            <p className="lp-empty">{failed ? "Could not reach Arc Mainnet." : "No coins launched on Arc Mainnet yet — be the first."}</p>
          )}
        </div>
      </div>
    </section>

    <section className="lp-section lp-products">
      <p className="lp-kicker">/ The full stack</p>
      <h2>Everything Arcodian does on Arc.</h2>
      <p className="lp-products-sub">One economy, four pillars — a self-custody money app, an open market, a bounded agent economy, and public contracts you can verify.</p>
      <div className="lp-pillars">
        {PILLARS.map((pillar) => (
          <div className="lp-pillar" key={pillar.group}>
            <header><h3>{pillar.group}</h3><span>{pillar.blurb}</span></header>
            <ul>
              {pillar.items.map((item) => {
                const inner = <><b>{item.name}</b><small>{item.desc}</small></>;
                return <li key={item.name}>{item.href
                  ? <a href={item.href} target="_blank" rel="noreferrer">{inner}<i aria-hidden="true">→</i></a>
                  : <button type="button" onClick={() => openTab(item.tab!)}>{inner}<i aria-hidden="true">→</i></button>}</li>;
              })}
            </ul>
          </div>
        ))}
      </div>
    </section>

    <section className="lp-section">
      <div className="lp-section-head">
        <div>
          <p className="lp-kicker">/ Live market</p>
          <h2>The radar is always on.</h2>
        </div>
        <a className="lp-link" href="/market">View all coins →</a>
      </div>
      <div className="lp-table">
        <div className="lp-tr lp-th">
          <span>#</span><span>ASSET</span>
          <span className="lp-right">VOLUME</span>
          <span className="lp-right">HOLDERS</span>
          <span className="lp-right lp-hide-sm">TRADES</span>
          <span className="lp-right lp-hide-sm">GRADUATION</span>
        </div>
        {visibleLiveMarkets.map((row, index) => (
          <button type="button" key={row.address} className="lp-tr" onClick={() => chooseCoin(row.address)}>
            <span className="lp-rank">{index + 1}</span>
            <span className="lp-asset">
              <span className="lp-avatar">{row.image ? <img src={imageUrl(row.image)} alt="" /> : row.symbol[0]}</span>
              <span>
                <b>{row.symbol}{row.currency === "EURC" && <i className="lp-eurc">EURC</i>}</b>
                <small>{row.name}</small>
              </span>
            </span>
            <span className="lp-right lp-num">{money(quoteAmount(row.volume, row.currency, row.globalPool), row.currency)}</span>
            <span className="lp-right lp-num">{row.holderCount}</span>
            <span className="lp-right lp-num lp-hide-sm">{row.tradeCount}</span>
            <span className="lp-right lp-hide-sm lp-prog">
              <i><em style={{ width: `${Math.min(100, row.progress)}%` }} /></i>
              <small>{row.graduated ? "graduated" : `${row.progress.toFixed(1)}%`}</small>
            </span>
          </button>
        ))}
        {ranked.length === 0 && <p className="lp-empty">{failed ? "Could not reach Arc Mainnet." : "No coins launched on Arc Mainnet yet — be the first."}</p>}
      </div>
      {ranked.length > 5 && (
        <button type="button" className="lp-link lp-expand" onClick={() => setShowAllMarkets((value) => !value)}>
          {showAllMarkets ? "Show top 5 ↑" : `Expand all ${ranked.length} markets ↓`}
        </button>
      )}
    </section>

    <section className="lp-section">
      <div className="lp-builder">
        <span aria-hidden="true" className="lp-builder-ring" />
        <span aria-hidden="true" className="lp-builder-ring lp-builder-ring-2" />
        <div>
          <p className="lp-kicker lp-kicker-light">/ For builders</p>
          <h2>Launch a coin the transparent way.</h2>
          <p>
            No hidden allocation, no private mempool head start. Deploy in minutes
            and let the market read the curve from the first block — the same view
            you get is the view everyone gets.
          </p>
          <div className="lp-hero-cta">
            <button type="button" className="lp-btn-light" onClick={enterMarket}>Start a launch</button>
            <button type="button" className="lp-btn-outline" onClick={() => openTab("how")}>Read the mechanics</button>
          </div>
        </div>
      </div>
    </section>

    <section className="lp-section lp-faq">
      <p className="lp-kicker lp-center">/ FAQ</p>
      <h2 className="lp-center">Questions, answered.</h2>
      <div className="lp-faq-list">
        {FAQS.map((item, index) => (
          <div key={item.q} className={openFaq === index ? "open" : ""}>
            <button type="button" onClick={() => setOpenFaq(openFaq === index ? -1 : index)} aria-expanded={openFaq === index}>
              <span>{item.q}</span><i aria-hidden="true">+</i>
            </button>
            {openFaq === index && <p>{item.a}</p>}
          </div>
        ))}
      </div>
    </section>

  </div>;
}

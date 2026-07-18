import { useEffect, useState } from "react";
import { formatEther } from "ethers";
import { imageUrl } from "../shared";
import { navHref } from "../config";

const RAILS: Array<{ tab: string; glyph: string; title: string; copy: string; accent: string }> = [
  { tab: "screener", glyph: "◫", title: "Market", copy: "Screen live curves, tape, and holders. Trade before graduation.", accent: "market" },
  { tab: "swap", glyph: "⇌", title: "Swap", copy: "Move between Arc Testnet assets with every address visible first.", accent: "swap" },
  { tab: "bridge", glyph: "⇄", title: "Bridge", copy: "Carry USDC in and out over official Circle CCTP rails.", accent: "bridge" },
  { tab: "fx", glyph: "◎", title: "StableCoin FX", copy: "USDC ⇄ EURC at one on-chain rate. No aggregator hop.", accent: "fx" },
];

export default function LandingExperience({ enterMarket, chooseCoin, openTab }: { enterMarket: () => void; chooseCoin: (address: string) => void; openTab: (tab: string) => void }) {
  const host = typeof window !== "undefined" ? window.location.hostname : "";
  const [markets, setMarkets] = useState<Array<{ address: string; symbol: string; name: string; image: string; reserve: string; volume24h: string; progress: number }>>([]);
  useEffect(() => {
    fetch("/data/market-index.json", { cache: "no-store" }).then((response) => response.json()).then((index: { launches?: Array<Record<string, unknown>> }) => {
      setMarkets((index.launches || []).map((item) => {
        const reserve = BigInt(String(item.reserve || "0")), threshold = BigInt(String(item.threshold || "1"));
        return { address: String(item.address), symbol: String(item.symbol), name: String(item.name), image: String(item.image || ""), reserve: String(item.reserve || "0"), volume24h: String(item.volume24h || "0"), progress: Boolean(item.graduated) ? 100 : Number(reserve * 10000n / threshold) / 100 };
      }).sort((a,b) => BigInt(b.volume24h) > BigInt(a.volume24h) ? 1 : -1).slice(0,3));
    }).catch(() => setMarkets([]));
  }, []);
  return <>
    <section className="landing-manifesto">
      <div><p className="kicker">Why Arcodian exists</p><h2>A market should show its workings.</h2></div>
      <p>Most launches ask for trust before they show the machinery. Arcodian starts with the machinery: one visible curve, public trades, clear graduation, and liquidity ownership sent where nobody can pull it back.</p>
      <span>Built around Arc's USDC-native economy—not retrofitted from a generic EVM template.</span>
    </section>
    <section className="landing-proof-grid">
      <article><b>01</b><h3>Born liquid</h3><p>A coin gets a market the moment it launches. Price discovery begins in the open.</p></article>
      <article><b>02</b><h3>No velvet rope</h3><p>Creator, contract, holders, tape, and curve sit in the same room for everyone.</p></article>
      <article><b>03</b><h3>Graduation means something</h3><p>At the threshold, liquidity moves to ARC DEX and LP ownership is burned.</p></article>
    </section>
    <section className="landing-rails" aria-label="Product rails">
      <div className="landing-rails-head"><p className="kicker">Four rails, one economy</p><h2>Pick your lane.</h2></div>
      <div className="rails-grid">
        {RAILS.map((rail) => {
          const href = navHref(rail.tab, host);
          const inner = <>
            <span className="rail-glyph" aria-hidden="true">{rail.glyph}</span>
            <b>{rail.title}</b>
            <p>{rail.copy}</p>
            <em>Open <i aria-hidden="true">↗</i></em>
            <span className="rail-shine" aria-hidden="true" />
          </>;
          return href ? (
            <a key={rail.tab} className={`rail-card rail-${rail.accent}`} href={href} target="_blank" rel="noreferrer">{inner}</a>
          ) : (
            <button key={rail.tab} className={`rail-card rail-${rail.accent}`} onClick={() => (rail.tab === "screener" ? enterMarket() : openTab(rail.tab))}>{inner}</button>
          );
        })}
      </div>
    </section>
    <section className="landing-live-window">
      <div className="landing-live-head"><div><p className="kicker">A window into the floor</p><h2>Markets moving now.</h2></div><button onClick={enterMarket}>Open full market →</button></div>
      <div className="landing-market-preview">{markets.length ? markets.map((market) => <button key={market.address} onClick={() => chooseCoin(market.address)}>
        <span>{market.image ? <img src={imageUrl(market.image)} alt="" /> : <b>{market.symbol[0]}</b>}<i><strong>{market.symbol}</strong><small>{market.name}</small></i></span>
        <span><small>24h tape</small><b>{Number(formatEther(BigInt(market.volume24h))).toLocaleString(undefined,{maximumFractionDigits:2})} USDC</b></span>
        <span><small>Graduation</small><b>{market.progress.toFixed(2)}%</b></span><em>Open ↗</em>
      </button>) : <p>The live floor is syncing with Arc.</p>}</div>
    </section>
    <section className="landing-final-cta"><div><p className="kicker">Your move</p><h2>Watch the tape—or put an idea on it.</h2><p>No pitch deck required. Just a wallet, a name, and a market the public can inspect.</p></div><button className="primary" onClick={enterMarket}>Enter the market</button></section>
  </>;
}

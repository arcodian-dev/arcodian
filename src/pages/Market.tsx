import { useEffect, useRef, useState } from "react";
import { BrowserProvider, Contract, formatEther, parseEther, verifyMessage } from "ethers";
import { ARC, ARC_EURC_ADDRESS, ARC_USDC_ERC20, CROSS_BUY_ROUTER_ADDRESS, ENGINE_VERSION, EURC_PUMP_FACTORY_ADDRESS, LEGACY_PUMP_FACTORY_ADDRESSES, PUMP_FACTORY_ADDRESS, TOKENS } from "../config";
import { ARC_PUMP_FACTORY_ABI } from "../generated/arcPumpFactory";
import { CurrencyToggle, loadDisplayCurrency } from "../components/CurrencyToggle";
import { CostLine } from "../components/CostLine";
import { convert, currencyOf, routeFor, trueCost, type Currency, type FxRate } from "../fx";
import { fetchFxRate } from "../fxRate";
import { isFreshMarketIndex } from "../marketData";
import {
  arcProvider,
  communitySigningMessage,
  imageUrl,
  normalizeSocial,
  patchActivity,
  safeEther,
  short,
  socialSigningMessage,
  writeActivity,
  type ArenaWinner,
  type CommunityPost,
  type LaunchAsset,
  type SocialLinks,
  type WalletOption,
} from "../shared";

export default function Screener({
  account,
  activeProvider,
  connect,
  coinAddress,
  chooseCoin,
  closeCoin,
}: {
  account: string;
  activeProvider: EthereumProvider | null;
  connect: () => void;
  coinAddress: string;
  chooseCoin: (address: string) => void;
  closeCoin: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("All");
  const [sortKey, setSortKey] = useState<"volume" | "change" | "holders" | "progress" | null>(null);
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [marketView, setMarketView] = useState<"markets" | "arena">("markets");
  // Display currency is presentation only — it never reaches a contract call.
  const [displayCurrency, setDisplayCurrency] = useState<Currency>(loadDisplayCurrency);
  const [fxRate, setFxRate] = useState<FxRate>({ eurcPerUsdc: 1, usdcPerEurc: 1 });
  const [launches, setLaunches] = useState<LaunchAsset[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [arenaHistory, setArenaHistory] = useState<ArenaWinner[]>([]);
  const marketIndexStamp = useRef("");
  const [arenaNow, setArenaNow] = useState(() => Date.now());
  const [watchlist, setWatchlist] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("arcodian-watchlist") || "[]")); }
    catch { return new Set(); }
  });
  function toggleWatch(address: string) {
    const next = new Set(watchlist);
    const key = address.toLowerCase();
    if (next.has(key)) next.delete(key); else next.add(key);
    setWatchlist(next);
    localStorage.setItem("arcodian-watchlist", JSON.stringify([...next]));
  }
  useEffect(() => {
    const timer = window.setInterval(() => setArenaNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    let cancelled = false;
    const provider = arcProvider();
    fetchFxRate(provider)
      .then((rate) => { if (!cancelled) setFxRate(rate); })
      .catch(() => { /* parity fallback already in state */ });
    return () => { cancelled = true; provider.destroy(); };
  }, []);
  useEffect(() => {
    const open = () => setShowCreate(true);
    if (sessionStorage.getItem("arcodian-open-create")) {
      sessionStorage.removeItem("arcodian-open-create");
      open();
    }
    window.addEventListener("arcodian:open-create", open);
    return () => window.removeEventListener("arcodian:open-create", open);
  }, []);
  useEffect(() => {
    const provider = arcProvider();
    (async () => {
      try {
        const response = await fetch("/data/market-index.json", { cache: "no-store" });
        if (response.ok) {
          const index = await response.json() as { indexedAt: string; arena?: { history?: ArenaWinner[] }; launches: Array<Omit<LaunchAsset, "reserve" | "virtualReserve" | "threshold" | "inventory" | "progress" | "type" | "risk"> & { reserve: string; virtualReserve: string; threshold: string; inventory: string }> };
          if (Array.isArray(index.launches) && isFreshMarketIndex(index.indexedAt)) {
            setArenaHistory(index.arena?.history || []);
            setLaunches(index.launches.map((item) => {
              const reserve = BigInt(item.reserve), virtualReserve = BigInt(item.virtualReserve), threshold = BigInt(item.threshold), inventory = BigInt(item.inventory);
              return { ...item, reserve, virtualReserve, threshold, inventory, type: item.graduated ? "Graduated" : "Meme", risk: item.graduated ? "DEX live" : "Curve", progress: item.graduated ? 100 : Number((reserve * 10000n) / threshold) / 100 };
            }));
            return;
          }
        }
      } catch { /* Fall through to canonical RPC reads. */ }
      const loadedGroups = await Promise.all(
        [PUMP_FACTORY_ADDRESS, ...LEGACY_PUMP_FACTORY_ADDRESSES].map(
          async (factoryAddress) => {
            const factory = new Contract(
              factoryAddress,
              ARC_PUMP_FACTORY_ABI,
              provider,
            );
            const count = Number(await factory.launchCount());
            return Promise.all(
              Array.from({ length: count }, async (_, index) => {
                const id = index + 1;
                const tokenAddress = (await factory.tokenByLaunch(
                  id,
                )) as string;
                const curveAddress = (await factory.curveByLaunch(
                  id,
                )) as string;
                const token = new Contract(
                  tokenAddress,
                  [
                    "function name() view returns(string)",
                    "function symbol() view returns(string)",
                    "function imageURI() view returns(string)",
                    "function balanceOf(address) view returns(uint256)",
                  ],
                  provider,
                );
                const curve = new Contract(
                  curveAddress,
                  [
                    "function realNativeReserve() view returns(uint256)",
                    "function VIRTUAL_NATIVE() view returns(uint256)",
                    "function graduationThreshold() view returns(uint256)",
                    "function graduated() view returns(bool)",
                    "function pair() view returns(address)",
                  ],
                  provider,
                );
                const [name, symbol, reserve, virtualReserve, threshold, graduated, inventory] =
                  await Promise.all([
                    token.name(),
                    token.symbol(),
                    curve.realNativeReserve(),
                    curve.VIRTUAL_NATIVE(),
                    curve.graduationThreshold(),
                    curve.graduated(),
                    token.balanceOf(curveAddress),
                  ]);
                let image = "";
                try {
                  image = await token.imageURI();
                } catch {
                  image = "";
                }
                return {
                  symbol,
                  name,
                  type: graduated ? "Graduated" : "Meme",
                  risk: graduated ? "DEX live" : "Curve",
                  address: tokenAddress,
                  curve: curveAddress,
                  image,
                  reserve,
                  virtualReserve,
                  threshold,
                  inventory,
                  graduated,
                  progress: graduated
                    ? 100
                    : Number((reserve * 10000n) / threshold) / 100,
                } as LaunchAsset;
              }),
            );
          },
        ),
      );
      setLaunches(loadedGroups.flat().reverse());
    })()
      .catch(() => setLaunches([]))
      .finally(() => setLoading(false));
    return () => {
      provider.destroy();
    };
  }, []);
  useEffect(() => {
    let stopped = false;
    let busy = false;
    const pollMarket = async () => {
      if (stopped || busy || document.visibilityState === "hidden") return;
      busy = true;
      try {
        const response = await fetch(`/data/market-index.json?t=${Date.now()}`, { cache: "no-store" });
        if (!response.ok) return;
        const index = await response.json() as { indexedAt: string; arena?: { history?: ArenaWinner[] }; launches: Array<Omit<LaunchAsset, "reserve" | "virtualReserve" | "threshold" | "inventory" | "progress" | "type" | "risk"> & { reserve: string; virtualReserve: string; threshold: string; inventory: string }> };
        if (!Array.isArray(index.launches) || !isFreshMarketIndex(index.indexedAt) || index.indexedAt === marketIndexStamp.current) return;
        marketIndexStamp.current = index.indexedAt;
        setArenaHistory(index.arena?.history || []);
        setLaunches(index.launches.map((item) => {
          const reserve = BigInt(item.reserve), virtualReserve = BigInt(item.virtualReserve), threshold = BigInt(item.threshold), inventory = BigInt(item.inventory);
          return { ...item, reserve, virtualReserve, threshold, inventory, type: item.graduated ? "Graduated" : "Meme", risk: item.graduated ? "DEX live" : "Curve", progress: item.graduated ? 100 : Number((reserve * 10000n) / threshold) / 100 };
        }));
      } catch { /* Keep the last valid market snapshot. */ }
      finally { busy = false; }
    };
    const onVisibility = () => { if (document.visibilityState === "visible") void pollMarket(); };
    const timer = window.setInterval(() => { void pollMarket(); }, 3_000);
    window.addEventListener("focus", pollMarket);
    document.addEventListener("visibilitychange", onVisibility);
    void pollMarket();
    return () => { stopped = true; window.clearInterval(timer); window.removeEventListener("focus", pollMarket); document.removeEventListener("visibilitychange", onVisibility); };
  }, []);
  const selected = coinAddress
    ? launches.find(
        (asset) => asset.address.toLowerCase() === coinAddress.toLowerCase(),
      ) || null
    : null;
  const stableRows = [
    {
      symbol: "USDC",
      name: "USD Coin",
      type: "Stablecoin",
      status: "Official",
      risk: "Low",
      address: ARC.nativeToken,
    },
    {
      symbol: "EURC",
      name: "Euro Coin",
      type: "Stablecoin",
      status: "Official",
      risk: "Low",
      address: TOKENS[1].address,
    },
  ];
  const launchRows = launches.slice().filter((item) => {
    if (filter === "Watchlist") return watchlist.has(item.address.toLowerCase());
    if (filter === "New") return !item.graduated;
    if (filter === "Trending") return true;
    if (filter === "Gainers") return (item.priceChange24h || 0) > 0;
    if (filter === "Graduating") return !item.graduated && item.progress >= 50;
    if (filter === "Graduated") return item.graduated;
    return filter === "All" || filter === "Meme";
  }).sort((a, b) => {
    if (filter === "New") return (b.createdAt || 0) - (a.createdAt || 0);
    if (filter === "Gainers") return (b.priceChange24h || 0) - (a.priceChange24h || 0);
    if (filter === "Graduating") return b.progress - a.progress;
    if (filter === "Trending") return Number(BigInt(b.volume24h || b.volume || "0") - BigInt(a.volume24h || a.volume || "0"));
    return a.reserve > b.reserve ? -1 : 1;
  });
  const rows = [...(filter === "All" || filter === "Stablecoin" ? stableRows : []), ...launchRows].filter(
    (item) =>
      `${item.symbol} ${item.name} ${item.address}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  function sortBy(key: "volume" | "change" | "holders" | "progress") {
    if (sortKey === key) setSortDir((dir) => (dir === 1 ? -1 : 1));
    else { setSortKey(key); setSortDir(-1); }
  }
  function rowMetric(item: (typeof rows)[number], key: "volume" | "change" | "holders" | "progress") {
    if (!("curve" in item)) return -1;
    if (key === "volume") return Number(formatEther(BigInt(item.volume24h || item.volume || "0")));
    if (key === "change") return item.priceChange24h || 0;
    if (key === "holders") return item.holderCount || 0;
    return item.progress;
  }
  const tableRows = sortKey ? [...rows].sort((a, b) => (rowMetric(b, sortKey) - rowMetric(a, sortKey)) * (sortDir === -1 ? 1 : -1)) : rows;
  const sortMark = (key: string) => (sortKey === key ? (sortDir === -1 ? " ↓" : " ↑") : "");
  const arenaContenders = launches
    .filter((item) => !item.graduated)
    .map((item) => ({
      ...item,
      arenaScore: Number(formatEther(BigInt(item.volume24h || "0"))) * 100
        + (item.tradeCount || 0) * 5
        + item.progress,
    }))
    .sort((a, b) => b.arenaScore - a.arenaScore)
    .slice(0, 2);
  const arenaLeader = arenaContenders[0];
  const arenaTotal = arenaContenders.reduce((sum, item) => sum + Math.max(item.arenaScore, 0.01), 0);
  const roundEnd = (() => {
    const date = new Date(arenaNow);
    const days = (8 - (date.getUTCDay() || 7)) % 7 || 7;
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days, 0, 0, 0);
  })();
  const roundRemaining = Math.max(0, roundEnd - arenaNow);
  const roundLabel = `${Math.floor(roundRemaining / 86_400_000)}d ${Math.floor((roundRemaining % 86_400_000) / 3_600_000)}h`;
  const arenaActivity = launches.flatMap((item) => (item.trades || []).map((trade) => ({ ...trade, symbol: item.symbol, token: item.address })))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 8);
  const arenaAlerts = [
    ...launches.filter((item) => (item.createdAt || 0) > Math.floor(Date.now() / 1000) - 86_400).map((item) => ({ id: `launch-${item.address}`, type: "NEW LAUNCH", title: `$${item.symbol} entered the orbit`, detail: "A new canonical market is live.", token: item.address, time: item.createdAt || 0 })),
    ...launches.filter((item) => item.graduated).map((item) => ({ id: `graduated-${item.address}`, type: "GRADUATED", title: `$${item.symbol} reached ARC DEX`, detail: "Bonding completed. LP ownership is burned.", token: item.address, time: item.createdAt || 0 })),
    ...arenaActivity.filter((trade) => BigInt(trade.native) >= parseEther("10")).map((trade) => ({ id: `move-${trade.tx}`, type: "BIG MOVE", title: `${trade.side} $${trade.symbol}`, detail: `${Number(formatEther(BigInt(trade.native))).toLocaleString(undefined,{maximumFractionDigits:2})} USDC confirmed onchain.`, token: trade.token, time: trade.timestamp || 0 })),
    ...launches.filter((item) => watchlist.has(item.address.toLowerCase()) && (item.trades || []).length > 0).map((item) => ({ id: `watch-${item.address}-${item.trades?.[0]?.tx}`, type: "WATCHLIST", title: `$${item.symbol} moved`, detail: "New activity on a market you watch.", token: item.address, time: item.trades?.[0]?.timestamp || 0 })),
  ].sort((a,b) => b.time - a.time).filter((item,index,items) => items.findIndex((candidate) => candidate.id === item.id) === index).slice(0,6);
  const creatorBoard = launches.reduce<Array<{ address: string; volume: bigint; launches: number }>>((board, item) => {
    if (!item.creator) return board;
    const found = board.find((row) => row.address.toLowerCase() === item.creator!.toLowerCase());
    if (found) { found.volume += BigInt(item.volume || "0"); found.launches += 1; }
    else board.push({ address: item.creator, volume: BigInt(item.volume || "0"), launches: 1 });
    return board;
  }, []).sort((a, b) => a.volume > b.volume ? -1 : 1).slice(0, 5);
  const totalTrades = launches.reduce((sum, item) => sum + (item.tradeCount || 0), 0);
  const totalVolume = launches.reduce((sum, item) => sum + BigInt(item.volume || "0"), 0n);
  const graduatedMarkets = launches.filter((item) => item.graduated).length;
  const traderBoard = arenaActivity.reduce<Array<{ address: string; volume: bigint; trades: number }>>((board, trade) => {
    const found = board.find((row) => row.address.toLowerCase() === trade.user.toLowerCase());
    if (found) { found.volume += BigInt(trade.native); found.trades += 1; }
    else board.push({ address: trade.user, volume: BigInt(trade.native), trades: 1 });
    return board;
  }, []).sort((a, b) => a.volume > b.volume ? -1 : 1).slice(0, 5);
  async function shareArena() {
    if (arenaContenders.length < 2) return;
    const text = `${arenaContenders[0].symbol} vs ${arenaContenders[1].symbol} — who owns the Arc arena?`;
    const url = `${window.location.origin}/?arena=${arenaContenders.map((item) => item.address).join(",")}`;
    if (navigator.share) await navigator.share({ title: "Arcodian Coin Arena", text, url });
    else await navigator.clipboard.writeText(`${text} ${url}`);
  }
  function shareArenaTo(network: "x" | "telegram") {
    if (arenaContenders.length < 2) return;
    const text = `${arenaContenders[0].symbol} vs ${arenaContenders[1].symbol} — who owns this week's Arcodian arena?`;
    const url = `${window.location.origin}/?arena=${arenaContenders.map((item) => item.address).join(",")}`;
    const target = network === "x"
      ? `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`
      : `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
    window.open(target, "_blank", "noopener,noreferrer");
  }
  function openArenaCard() {
    const tokens = arenaContenders.map((item) => item.address).join(",");
    if (tokens) window.open(`/api/share-card.php?arena=${encodeURIComponent(tokens)}`, "_blank", "noopener,noreferrer");
  }
  if (coinAddress) {
    if (loading)
      return (
        <section className="coin-page-shell">
          <div className="loading-board">Loading coin market onchain…</div>
        </section>
      );
    if (!selected)
      return (
        <section className="coin-page-shell">
          <div className="not-found">
            <h2>Coin not found</h2>
            <p>This contract is not registered by a canonical ARC factory.</p>
            <button className="primary" onClick={closeCoin}>
              Back to market
            </button>
          </div>
        </section>
      );
    return (
      <TradingDesk
        asset={selected}
        account={account}
        activeProvider={activeProvider}
        connect={connect}
        close={closeCoin}
        fxRate={fxRate}
      />
    );
  }
  return (
    <section className="market-board market-terminal" id="market">
      <div className="terminal-stats">
        <span>
          <b>LIVE</b> Arc Testnet
        </span>
        <span>{launches.length} canonical markets</span>
        <span>{totalTrades} confirmed trades</span>
        <span>{Number(formatEther(totalVolume)).toLocaleString(undefined,{maximumFractionDigits:2})} USDC volume</span>
        <span>{graduatedMarkets} graduated · LP locked</span>
      </div>
      <div className="board-head">
        <div>
          <p className="kicker">The market floor · live onchain</p>
          <h2>
            See what is moving.
            <br />
            Decide for yourself.
          </h2>
        </div>
        <button className="primary compact" onClick={() => setShowCreate(true)}>
          + Create coin
        </button>
      </div>
      <div className="market-view-tabs" role="tablist" aria-label="Market workspace">
        <button role="tab" aria-selected={marketView === "markets"} className={marketView === "markets" ? "active" : ""} onClick={() => setMarketView("markets")}><span>01</span> Markets <small>Discover and trade</small></button>
        <button role="tab" aria-selected={marketView === "arena"} className={marketView === "arena" ? "active" : ""} onClick={() => setMarketView("arena")}><span>02</span> Coin Arena <small>Weekly onchain contest</small></button>
      </div>
      <section className="market-proof-strip" aria-label="Canonical market proof">
        <span><small>ENGINE</small><b>v{ENGINE_VERSION}</b></span>
        <span><small>FACTORIES</small><b>USDC + EURC canonical</b></span>
        <span><small>GRADUATION</small><b>4,500 stablecoin reserve</b></span>
        <a href="/contracts">Verify deployment →</a>
      </section>
      {marketView === "arena" && <div className="arena-workspace">
      <section className="coin-arena" aria-label="Coin Arena">
        <div className="arena-head">
          <div><p className="kicker">Coin Arena · weekly round · {roundLabel} left</p><h3>Two markets enter the orbit.</h3></div>
          <div className="arena-share"><button onClick={() => void shareArena()} disabled={arenaContenders.length < 2}>Share ↗</button><button onClick={openArenaCard} disabled={arenaContenders.length < 2}>Card</button><button onClick={() => shareArenaTo("x")} disabled={arenaContenders.length < 2}>X</button><button onClick={() => shareArenaTo("telegram")} disabled={arenaContenders.length < 2}>Telegram</button></div>
        </div>
        {arenaContenders.length >= 2 ? (
          <div className="arena-matchup">
            {arenaContenders.map((item, index) => {
              const share = Math.round((Math.max(item.arenaScore, 0.01) / arenaTotal) * 100);
              return <div className={`arena-fighter ${item.address === arenaLeader?.address ? "leader" : ""}`} key={item.address} onClick={() => chooseCoin(item.address)}>
                <div className="arena-identity">
                  {item.image ? <img src={imageUrl(item.image)} alt="" /> : <b>{item.symbol[0]}</b>}
                  <span><small>{index === 0 ? "Leading now" : "Challenger"}</small><strong>{item.symbol}</strong><em>{item.name}</em></span>
                </div>
                <div className="arena-score"><strong>{share}%</strong><span>{Number(formatEther(BigInt(item.volume24h || "0"))).toLocaleString(undefined,{maximumFractionDigits:2})} USDC · {item.tradeCount || 0} trades</span></div>
                <div className="arena-meter"><i style={{width:`${share}%`}} /></div>
              </div>;
            })}
            <span className="arena-vs">VS</span>
          </div>
        ) : <p className="arena-empty">The arena opens when two community coins are live. Every score comes from onchain activity.</p>}
        <p className="arena-rules">Ranked by 24h volume, confirmed trades, and graduation progress. No manual votes. No paid placement.</p>
      </section>
      <section className="arena-live-grid">
        <article className="arena-tape">
          <div className="arena-section-head"><span><i /> Live arena tape</span><small>Onchain · indexed</small></div>
          {arenaActivity.length ? <div className="arena-ticker" aria-label="Latest confirmed trades"><div className="arena-ticker-track">{[...arenaActivity, ...arenaActivity].map((trade, index) => {
            const amount = Number(formatEther(BigInt(trade.native)));
            const duplicate = index >= arenaActivity.length;
            return <button key={`${trade.tx}-${trade.symbol}-${index}`} tabIndex={duplicate ? -1 : 0} aria-hidden={duplicate} onClick={() => chooseCoin(trade.token)}>
              <b className={trade.side === "BUY" ? "buy" : "sell"}>{trade.side}</b><strong>${trade.symbol}</strong><span>{amount.toLocaleString(undefined,{minimumFractionDigits: amount > 0 && amount < 0.01 ? 4 : 2,maximumFractionDigits:4})} USDC</span>{amount >= 10 && <em>BIG MOVE</em>}<small>{short(trade.user)}</small>
            </button>;
          })}</div></div> : <p className="arena-data-empty">The tape is quiet. The next confirmed trade appears here automatically.</p>}
        </article>
        <article className="arena-leaderboards">
          <div className="arena-section-head"><span>Weekly leaders</span><small>Public wallet data</small></div>
          <div className="leaderboard-columns">
            <div><h4>Creators</h4>{creatorBoard.map((row,index) => <p key={row.address}><b>#{index+1}</b><span>{short(row.address)}<small>{row.launches} launch{row.launches === 1 ? "" : "es"}</small></span><strong>{Number(formatEther(row.volume)).toLocaleString(undefined,{maximumFractionDigits:2})}</strong></p>)}</div>
            <div><h4>Traders</h4>{traderBoard.map((row,index) => <p key={row.address}><b>#{index+1}</b><span>{short(row.address)}<small>{row.trades} trade{row.trades === 1 ? "" : "s"}</small></span><strong>{Number(formatEther(row.volume)).toLocaleString(undefined,{maximumFractionDigits:2})}</strong></p>)}</div>
          </div>
        </article>
      </section>
      <section className="arena-alerts" aria-label="Arena alerts">
        <div className="arena-alerts-head"><div><p className="kicker">Arena alerts</p><h3>Signals worth looking at.</h3></div><span>Canonical index · refreshes every 60s</span></div>
        {arenaAlerts.length ? <div className="arena-alert-list">{arenaAlerts.map((alert) => <button key={alert.id} onClick={() => chooseCoin(alert.token)}><b>{alert.type}</b><span><strong>{alert.title}</strong><small>{alert.detail}</small></span><em>View ↗</em></button>)}</div> : <p className="arena-data-empty">No large move, launch, graduation, or watchlist activity needs attention yet.</p>}
      </section>
      <section className="hall-of-orbit">
        <div><p className="kicker">Hall of Orbit</p><h3>Rounds leave a trace.</h3><span>Weekly winners are finalized by the indexer from the last onchain standings—never selected by an admin.</span></div>
        {arenaHistory.length ? <div className="orbit-winners">{arenaHistory.slice(0,4).map((entry,index) => <button key={entry.roundId} onClick={() => chooseCoin(entry.winner.token)}><b>{index === 0 ? "Latest" : `#${index+1}`}</b><span><strong>{entry.winner.symbol}</strong><small>Week of {entry.roundId}</small></span><em>{entry.winner.tradeCount} trades</em></button>)}</div> : <div className="orbit-awaiting"><strong>First crown pending</strong><span>The inaugural winner locks when this weekly round closes.</span></div>}
      </section>
      </div>}
      {marketView === "markets" && <div className="markets-workspace">
      <div className="search">
        <span>⌕</span>
        <input
          aria-label="Search assets"
          placeholder="Search name, ticker, or contract address"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="filters">
        {["All", "New", "Trending", "Gainers", "Graduating", "Graduated", "Watchlist"].map((item) => (
          <button
            className={filter === item ? "active" : ""}
            key={item}
            onClick={() => setFilter(item)}
          >
            {item}
          </button>
        ))}
        <CurrencyToggle value={displayCurrency} onChange={setDisplayCurrency} />
      </div>
      {loading ? (
        <div className="loading-board">
          Reading canonical factories onchain…
        </div>
      ) : (
        <>
        <div className="market-table-view" role="table" aria-label="Markets">
          <div className="mt-row mt-head" role="row">
            <span>Market</span>
            <button onClick={() => sortBy("volume")} className={sortKey === "volume" ? "active" : ""}>24h Vol{sortMark("volume")}</button>
            <button onClick={() => sortBy("change")} className={sortKey === "change" ? "active" : ""}>24h %{sortMark("change")}</button>
            <button onClick={() => sortBy("holders")} className={sortKey === "holders" ? "active" : ""}>Holders{sortMark("holders")}</button>
            <button onClick={() => sortBy("progress")} className={sortKey === "progress" ? "active" : ""}>Bonding{sortMark("progress")}</button>
            <span>Status</span>
            <span aria-hidden="true" />
          </div>
          {tableRows.map((item) => "curve" in item ? (
            <div className="mt-row" role="row" tabIndex={0} key={`t-${item.address}`}
              onClick={() => chooseCoin(item.address)}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); chooseCoin(item.address); } }}>
              <span className="mt-market">
                {item.image ? <img src={imageUrl(item.image)} alt="" /> : <b>{item.symbol.slice(0, 1)}</b>}
                <span><strong>{item.symbol}</strong><small>{item.name}</small></span>
              </span>
              <span className="mt-num">{convert(
                Number(formatEther(BigInt(item.volume24h || item.volume || "0"))),
                currencyOf(item),
                displayCurrency,
                fxRate,
              ).toLocaleString(undefined, { maximumFractionDigits: 2 })} <small>{displayCurrency}</small></span>
              <span className={`mt-num ${(item.priceChange24h || 0) >= 0 ? "positive" : "negative"}`}>{(item.priceChange24h || 0) >= 0 ? "+" : ""}{(item.priceChange24h || 0).toFixed(2)}%</span>
              <span className="mt-num">{item.holderCount || 0}</span>
              <span className="mt-progress"><i><em style={{ width: `${Math.min(100, item.progress)}%` }} /></i><b>{item.progress.toFixed(1)}%</b></span>
              <span className={`mt-status ${item.graduated ? "dex" : "curve"}`}>{item.graduated ? "Arcodian DEX" : item.risk}</span>
              <button className={watchlist.has(item.address.toLowerCase()) ? "mt-watch active" : "mt-watch"} aria-label={`Toggle ${item.symbol} watchlist`} onClick={(event) => { event.stopPropagation(); toggleWatch(item.address); }}>{watchlist.has(item.address.toLowerCase()) ? "★" : "☆"}</button>
            </div>
          ) : (
            <div className="mt-row mt-official" role="row" key={`t-${item.address}`}>
              <span className="mt-market"><b>{item.symbol.slice(0, 1)}</b><span><strong>{item.symbol}</strong><small>{item.name}</small></span></span>
              <span className="mt-num">—</span><span className="mt-num">—</span><span className="mt-num">—</span>
              <span className="mt-progress"><small>Circle official asset</small></span>
              <span className="mt-status official">Official</span>
              <a href={`${ARC.explorer}/address/${item.address}`} target="_blank" rel="noreferrer" aria-label={`View ${item.symbol} contract`}>↗</a>
            </div>
          ))}
          {!tableRows.length && <div className="loading-board">No market matches this filter.</div>}
        </div>
        <div className="coin-grid market-cards-view">
          {rows.map((item) => (
            <article
              className={`coin-card ${"curve" in item ? "tradeable" : ""}`}
              key={item.address}
              onClick={() => {
                if ("curve" in item) chooseCoin(item.address);
              }}
            >
              <div className="coin-top">
                <span className="asset">
                  {"image" in item && item.image ? (
                    <img src={imageUrl(item.image)} alt={item.symbol} />
                  ) : (
                    <b>{item.symbol.slice(0, 1)}</b>
                  )}
                  <span>
                    <strong>{item.symbol}</strong>
                    <small>{item.name}</small>
                  </span>
                </span>
                <span className="coin-card-actions">
                  {"curve" in item && (
                    <button className={watchlist.has(item.address.toLowerCase()) ? "watch active" : "watch"} aria-label="Toggle watchlist" onClick={(event) => { event.stopPropagation(); toggleWatch(item.address); }}>
                      {watchlist.has(item.address.toLowerCase()) ? "★" : "☆"}
                    </button>
                  )}
                  <span className="verified">● {item.risk}</span>
                </span>
              </div>
              {"progress" in item ? (
                <>
                  <div className="coin-discovery-metrics">
                    <span><small>All-time volume</small><b>{Number(formatEther(BigInt(item.volume || "0"))).toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC</b></span>
                    <span><small>Holders</small><b>{item.holderCount || 0}</b></span>
                    <span><small>24h</small><b className={(item.priceChange24h || 0) >= 0 ? "positive" : "negative"}>{(item.priceChange24h || 0) >= 0 ? "+" : ""}{(item.priceChange24h || 0).toFixed(2)}%</b></span>
                  </div>
                  <div className="mini-chart">
                    <i />
                    <i />
                    <i />
                    <i />
                    <i />
                    <i />
                    <i />
                  </div>
                  <div className="progress-copy">
                    <span>Bonding progress</span>
                    <b>{item.progress.toFixed(2)}%</b>
                  </div>
                  <div className="progress-bar">
                    <i style={{ width: `${Math.min(100, item.progress)}%` }} />
                  </div>
                  <button>Open {item.symbol} market →</button>
                </>
              ) : (
                <>
                  <div className="official-asset">Circle official asset</div>
                  <a
                    href={`${ARC.explorer}/address/${item.address}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View contract ↗
                  </a>
                </>
              )}
            </article>
          ))}
        </div>
        </>
      )}
      <div className="empty-note">
        <span>The contracts are the source</span>
        <p>
          Nothing here is hand-listed. Arcodian reads every launch from the
          canonical factories. Open a market to inspect the contract and its tape.
        </p>
      </div>
      </div>}
      {showCreate && (
        <div className="trade-overlay" onMouseDown={() => setShowCreate(false)}>
          <section
            className="create-modal"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              className="trade-close"
              onClick={() => setShowCreate(false)}
            >
              ×
            </button>
            <Launch
              account={account}
              activeProvider={activeProvider}
              connect={connect}
              onCreated={(asset) => {
                setLaunches((current) => [asset, ...current.filter((item) => item.address.toLowerCase() !== asset.address.toLowerCase())]);
                setShowCreate(false);
                chooseCoin(asset.address);
              }}
            />
          </section>
        </div>
      )}
    </section>
  );
}

function TradingDesk({
  asset,
  account,
  activeProvider,
  connect,
  close,
  fxRate,
}: {
  asset: LaunchAsset;
  account: string;
  activeProvider: EthereumProvider | null;
  connect: () => void;
  close: () => void;
  fxRate: FxRate;
}) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [deskTab, setDeskTab] = useState<"trades" | "holders" | "community">("trades");
  const [amount, setAmount] = useState("1");
  const [slippage, setSlippage] = useState("1");
  const [balance, setBalance] = useState(0n);
  const [inventory, setInventory] = useState(asset.inventory);
  const [reserve, setReserve] = useState(asset.reserve);
  const [graduated, setGraduated] = useState(asset.graduated);
  const [pair, setPair] = useState(asset.pair || "");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [eurcBalance, setEurcBalance] = useState(0n);
  const [txHash, setTxHash] = useState("");
  const [tradeStage, setTradeStage] = useState<"idle" | "quote" | "approval" | "submitted" | "confirmed" | "error">("idle");
  const [posts, setPosts] = useState<CommunityPost[]>([]);
  const [socials, setSocials] = useState<SocialLinks | null>(null);
  const [postText, setPostText] = useState("");
  const [posting, setPosting] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportCategory, setReportCategory] = useState("scam");
  const [reportDetail, setReportDetail] = useState("");
  const [timeframe, setTimeframe] = useState<60 | 300 | 900 | 3600>(300);
  const [chartWindow, setChartWindow] = useState(30);
  const [chartHover, setChartHover] = useState<number | null>(null);
  const [chartFullscreen, setChartFullscreen] = useState(false);
  const [netCost, setNetCost] = useState(0n);
  const [liveTrades, setLiveTrades] = useState<
    Array<{ side: "BUY" | "SELL"; amount: bigint; tokens: bigint }>
  >([]);
  const [chartTrades, setChartTrades] = useState<NonNullable<LaunchAsset["trades"]>>(asset.trades || []);
  const [tapeHealth, setTapeHealth] = useState<"live" | "delayed" | "offline">("delayed");
  const optimisticTapeUntil = useRef(0);
  const liveAsset = { ...asset, graduated, pair };
  const currency = asset.currency || "USDC";
  const validAmount = Number(amount) > 0;
  const amountWei = validAmount ? safeEther(amount) : 0n;
  // What the buyer actually spends. USDC is the chain's gas token and so the
  // default holding; a EURC-quoted market only routes direct when the wallet
  // already holds enough EURC to cover the trade.
  const holdingCurrency: Currency = currencyOf(asset) === "USDC"
    ? "USDC"
    : eurcBalance > 0n && eurcBalance >= amountWei / 10n ** 12n
      ? "EURC"
      : "USDC";
  // On the cross route the buyer types a USDC amount but the venue prices in
  // EURC. Convert once, here, so every downstream quote is in the venue's
  // currency. Direct routes pass through untouched.
  const venueAmountWei = holdingCurrency === currencyOf(asset)
    ? amountWei
    : (amountWei * BigInt(Math.round(fxRate.eurcPerUsdc * 1_000_000))) / 1_000_000n;
  const x = graduated ? reserve : asset.virtualReserve + reserve;
  const buyInput = graduated ? (venueAmountWei * 9970n) / 10000n : (venueAmountWei * 99n) / 100n;
  const sellInput = graduated ? (amountWei * 9975n) / 10000n : amountWei;
  const rawQuote = side === "buy"
    ? buyInput && inventory ? (inventory * buyInput) / (x + buyInput) : 0n
    : sellInput && inventory
      ? graduated
        ? ((x * sellInput) / (inventory + sellInput) * 9995n) / 10000n
        : ((x - (x * inventory) / (inventory + sellInput)) * 99n) / 100n
      : 0n;
  const quote = rawQuote > reserve && side === "sell" ? 0n : rawQuote;
  const minimumReceived = quote > 0n
    ? (quote * BigInt(Math.floor((100 - Number(slippage || 0)) * 100))) / 10000n
    : 0n;
  const insufficientBalance = side === "sell" && amountWei > balance;
  const venueFeeLabel = graduated
    ? side === "buy" ? "0.30% ARC DEX fee" : "0.30% ARC DEX + protocol fee"
    : "1.00% bonding-curve fee";
  const cost = trueCost(Number(amount) || 0, holdingCurrency, liveAsset, fxRate);
  const route = routeFor(holdingCurrency, liveAsset);

  async function refreshOnchain(provider: BrowserProvider | ReturnType<typeof arcProvider>) {
    const isEurc = asset.quoteKind === 1;
    // Both ArcPair quote assets use 6 decimals. Curve USDC reserves are native
    // 18-dec values, but after graduation reserve0/reserve1 are ERC-20 units.
    // Normalize every pair quote reserve to the terminal's 18-dec convention.
    const pairScale = 10n ** 12n;
    const curveState = new Contract(
      asset.curve,
      ["function graduated() view returns(bool)", "function pair() view returns(address)"],
      provider,
    );
    const [nextGraduated, nextPair] = await Promise.all([
      curveState.graduated() as Promise<boolean>,
      curveState.pair() as Promise<string>,
    ]);
    const nextVenue = nextGraduated && nextPair !== "0x0000000000000000000000000000000000000000"
      ? nextPair
      : asset.curve;
    const token = new Contract(asset.address, ["function balanceOf(address) view returns(uint256)"], provider);
    let nextReserve: bigint;
    let nextInventory: bigint;
    if (nextGraduated) {
      const venue = new Contract(nextVenue, ["function token0() view returns(address)", "function reserve0() view returns(uint256)", "function reserve1() view returns(uint256)"], provider);
      const [token0, reserve0, reserve1] = await Promise.all([
        venue.token0() as Promise<string>, venue.reserve0() as Promise<bigint>, venue.reserve1() as Promise<bigint>,
      ]);
      const tokenIs0 = token0.toLowerCase() === asset.address.toLowerCase();
      nextInventory = tokenIs0 ? reserve0 : reserve1;
      nextReserve = (tokenIs0 ? reserve1 : reserve0) * pairScale;
    } else {
      const nextReserveFn = isEurc ? "realQuoteReserve" : "realNativeReserve";
      const venue = new Contract(nextVenue, [`function ${nextReserveFn}() view returns(uint256)`], provider);
      [nextReserve, nextInventory] = await Promise.all([
        venue[nextReserveFn]() as Promise<bigint>, token.balanceOf(nextVenue) as Promise<bigint>,
      ]);
      if (isEurc) nextReserve *= pairScale;
    }
    setGraduated(nextGraduated);
    setPair(nextGraduated ? nextPair : "");
    setReserve(nextReserve);
    setInventory(nextInventory);
  }

  useEffect(() => {
    const provider = arcProvider();
    let stopped = false;
    let busy = false;
    const poll = async () => {
      if (stopped || busy || document.visibilityState === "hidden") return;
      busy = true;
      try { await refreshOnchain(provider); } catch { /* The live tape remains available during an RPC retry. */ }
      finally { busy = false; }
    };
    void poll();
    // Direct venue state is the terminal's source of truth. One-second cadence
    // keeps reserve/price/graduation responsive without allowing overlapping RPC
    // calls when a provider is briefly slow.
    const timer = window.setInterval(() => { void poll(); }, 1_000);
    return () => { stopped = true; window.clearInterval(timer); provider.destroy(); };
  }, [asset.address, asset.curve, asset.quoteKind]);

  async function refresh() {
    try {
      const response = await fetch("/data/market-index.json", { cache: "no-store" });
      if (!response.ok) throw new Error("INDEX_UNAVAILABLE");
      const index = await response.json() as {
        indexedAt?: string;
        launches?: Array<{
          address: string; reserve: string; inventory: string;
          trades?: Array<{ side: "BUY" | "SELL"; user: string; native: string; tokens: string }>;
        }>;
      };
      if (!isFreshMarketIndex(index.indexedAt)) throw new Error("INDEX_STALE");
      const market = index.launches?.find((item) => item.address.toLowerCase() === asset.address.toLowerCase());
      if (!market) throw new Error("MARKET_NOT_INDEXED");
      const trades = market.trades || [];
      // Reserve and inventory are polled directly from the active venue above.
      // The minute-scale index is history/holder data only and must never roll
      // a fresher onchain quote backwards between trades.
      setTapeHealth(index.indexedAt && Date.now() - Date.parse(index.indexedAt) <= 30_000 ? "live" : "delayed");
      if (account) {
        const mine = trades.filter((event) => event.user.toLowerCase() === account.toLowerCase());
        const paid = mine.filter((event) => event.side === "BUY").reduce((sum, event) => sum + BigInt(event.native), 0n);
        const received = mine.filter((event) => event.side === "SELL").reduce((sum, event) => sum + BigInt(event.native), 0n);
        setNetCost(paid > received ? paid - received : 0n);
      } else setNetCost(0n);
      if (Date.now() >= optimisticTapeUntil.current) {
        setLiveTrades(
          trades.slice(-12).reverse().map((event) => ({
            side: event.side,
            amount: BigInt(event.native),
            tokens: BigInt(event.tokens),
          })),
        );
      }
    } catch {
      setTapeHealth("offline");
    }
  }
  useEffect(() => {
    let refreshing = false;
    const poll = async () => {
      if (refreshing || document.visibilityState === "hidden") return;
      refreshing = true;
      try { await refresh(); } finally { refreshing = false; }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 3_000);
    return () => window.clearInterval(timer);
  }, [asset.address, account]);

  useEffect(() => {
    let loadingTape = false;
    const loadTape = async () => {
      if (loadingTape || document.visibilityState === "hidden") return;
      loadingTape = true;
      try {
        const response = await fetch("/data/live-tape.json", { cache: "no-store" });
        if (!response.ok) throw new Error("TAPE_UNAVAILABLE");
        const tape = await response.json() as {
          indexedAt?: string;
          trades?: Array<{ token: string; side: "BUY" | "SELL"; block: number; tx: string; user: string; native: string; tokens: string; timestamp: number }>;
        };
        const marketTrades = (tape.trades || []).filter((trade) => trade.token.toLowerCase() === asset.address.toLowerCase());
        setTapeHealth(tape.indexedAt && Date.now() - Date.parse(tape.indexedAt) <= 5_000 ? "live" : "delayed");
        setChartTrades(
          [...(asset.trades || []), ...marketTrades]
            .filter((trade, index, all) => all.findIndex((item) => item.tx === trade.tx && item.side === trade.side) === index)
            .sort((a, b) => a.block - b.block)
            .slice(-500),
        );
        if (marketTrades.length && Date.now() >= optimisticTapeUntil.current) {
          setLiveTrades(marketTrades.slice(-12).reverse().map((event) => ({ side: event.side, amount: BigInt(event.native), tokens: BigInt(event.tokens) })));
        }
      } catch { setTapeHealth("offline"); }
      finally { loadingTape = false; }
    };
    void loadTape();
    // Tape is a small static snapshot served locally; poll slightly faster than
    // the chain state so a newly indexed trade reaches the chart immediately.
    const timer = window.setInterval(() => { void loadTape(); }, 750);
    return () => window.clearInterval(timer);
  }, [asset.address]);

  useEffect(() => {
    if (!account || !activeProvider) { setBalance(0n); return; }
    const provider = new BrowserProvider(activeProvider as never);
    const token = new Contract(asset.address, ["function balanceOf(address) view returns(uint256)"], provider);
    void token.balanceOf(account).then((value: bigint) => setBalance(value)).catch(() => undefined);
  }, [asset.address, account, activeProvider]);

  // EURC holdings decide whether a EURC-quoted market routes direct or crosses
  // from USDC. Failing to read it falls back to USDC, which is always routable.
  useEffect(() => {
    if (!account || !activeProvider || currencyOf(asset) !== "EURC") { setEurcBalance(0n); return; }
    const provider = new BrowserProvider(activeProvider as never);
    const eurc = new Contract(ARC_EURC_ADDRESS, ["function balanceOf(address) view returns(uint256)"], provider);
    void eurc.balanceOf(account).then((value: bigint) => setEurcBalance(value)).catch(() => setEurcBalance(0n));
  }, [asset.address, account, activeProvider]);

  async function trade() {
    if (!activeProvider) {
      connect();
      return;
    }
    if (
      !validAmount ||
      quote <= 0n ||
      Number(slippage) < 0.1 ||
      Number(slippage) > 20
    ) {
      setStatus("Enter a valid amount and 0.1–20% slippage.");
      return;
    }
    setBusy(true);
    setTxHash("");
    setTradeStage("quote");
    setStatus("Refreshing quote and preparing wallet confirmation…");
    try {
      await activeProvider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: ARC.hexId }],
      });
      const provider = new BrowserProvider(activeProvider as never);
      const signer = await provider.getSigner();
      const venueAddress = graduated && pair ? pair : asset.curve;
      const tokenReader = new Contract(
        asset.address,
        ["function balanceOf(address) view returns(uint256)"],
        provider,
      );
      const isEurc = asset.quoteKind === 1;
      const QSCALE = 10n ** 12n; // EURC 6-dec <-> normalized 18-dec
      let freshInventory: bigint;
      let freshReserve: bigint;
      let pairReader: Contract | null = null;
      let pairZeroForOne = false;
      if (graduated) {
        pairReader = new Contract(venueAddress, ["function token0() view returns(address)", "function reserve0() view returns(uint256)", "function reserve1() view returns(uint256)", "function quote(bool,uint256) view returns(uint256)", "function swap(bool,uint256,uint256,uint64) returns(uint256)"], signer);
        const [token0, reserve0, reserve1] = await Promise.all([
          pairReader.token0() as Promise<string>, pairReader.reserve0() as Promise<bigint>, pairReader.reserve1() as Promise<bigint>,
        ]);
        const tokenIs0 = token0.toLowerCase() === asset.address.toLowerCase();
        freshInventory = tokenIs0 ? reserve0 : reserve1;
        freshReserve = (tokenIs0 ? reserve1 : reserve0) * QSCALE;
        const inputToken = side === "buy" ? (isEurc ? ARC_EURC_ADDRESS : ARC_USDC_ERC20) : asset.address;
        pairZeroForOne = token0.toLowerCase() === inputToken.toLowerCase();
      } else {
        const reserveFn = isEurc ? "realQuoteReserve" : "realNativeReserve";
        const venueReader = new Contract(venueAddress, [`function ${reserveFn}() view returns(uint256)`], provider);
        [freshInventory, freshReserve] = await Promise.all([
          tokenReader.balanceOf(venueAddress) as Promise<bigint>, venueReader[reserveFn]() as Promise<bigint>,
        ]);
        if (isEurc) freshReserve *= QSCALE;
      }
      const freshX = graduated
        ? freshReserve
        : asset.virtualReserve + freshReserve;
      const freshBuyInput = graduated
        ? (venueAmountWei * 9970n) / 10000n
        : (venueAmountWei * 99n) / 100n;
      const freshSellInput = graduated
        ? (amountWei * 9975n) / 10000n
        : amountWei;
      const pairInput = side === "buy" ? venueAmountWei / QSCALE : amountWei;
      const pairOutput = graduated && pairReader
        ? await pairReader.quote(pairZeroForOne, pairInput) as bigint
        : 0n;
      const freshRawQuote = graduated
        ? (side === "buy" ? pairOutput : pairOutput * QSCALE)
        : side === "buy"
        ? freshBuyInput && freshInventory
          ? (freshInventory * freshBuyInput) / (freshX + freshBuyInput)
          : 0n
        : freshSellInput && freshInventory
          ? graduated
            ? (((freshX * freshSellInput) / (freshInventory + freshSellInput)) * 9995n) / 10000n
            : ((freshX - (freshX * freshInventory) / (freshInventory + freshSellInput)) * 99n) / 100n
          : 0n;
      const freshQuote = side === "sell" && freshRawQuote > freshReserve
        ? 0n
        : freshRawQuote;
      if (freshQuote <= 0n) throw new Error("NO_LIQUIDITY");
      const curve = new Contract(
        venueAddress,
        isEurc
          ? [
              "function buy(uint256,uint256,uint64) returns(uint256)",
              "function sell(uint256,uint256,uint64) returns(uint256)",
            ]
          : [
              "function buy(uint256,uint64) payable returns(uint256)",
              "function sell(uint256,uint256,uint64) returns(uint256)",
            ],
        signer,
      );
      const minOut =
        (freshQuote * BigInt(Math.floor((100 - Number(slippage)) * 100))) / 10000n;
      const deadline = Math.floor(Date.now() / 1000) + 600;
      const erc20Abi = [
        "function allowance(address,address) view returns(uint256)",
        "function approve(address,uint256) returns(bool)",
      ];
      const owner = await signer.getAddress();
      let tx;
      if (graduated) {
        if (!pairReader) throw new Error("NO_LIQUIDITY");
        if (route === "manual") throw new Error("Switch to the pair quote currency before trading this graduated market.");
        const inputTokenAddress = side === "buy" ? (isEurc ? ARC_EURC_ADDRESS : ARC_USDC_ERC20) : asset.address;
        const pairAmountIn = side === "buy" ? amountWei / QSCALE : amountWei;
        const pairMinOut = side === "buy" ? minOut : minOut / QSCALE;
        const inputToken = new Contract(inputTokenAddress, erc20Abi, signer);
        const allowance = await inputToken.allowance(owner, venueAddress) as bigint;
        if (allowance < pairAmountIn) {
          setTradeStage("approval");
          setStatus(`Approve ${side === "buy" ? currency : asset.symbol} spending in your wallet.`);
          await (await inputToken.approve(venueAddress, pairAmountIn)).wait();
        }
        tx = await pairReader.swap(pairZeroForOne, pairAmountIn, pairMinOut, deadline);
      } else if (side === "buy") {
        if (route === "cross") {
          // Atomic USDC -> EURC -> curve buy. If any leg fails the whole
          // transaction reverts and the buyer keeps their USDC; they are never
          // left holding EURC. See ArcCrossBuyRouter.
          const usdcIn = amountWei / QSCALE;
          if (usdcIn <= 0n) throw new Error("Amount too small for USDC (min 0.000001).");
          const usdcErc20 = new Contract(ARC_USDC_ERC20, erc20Abi, signer);
          const allowance = (await usdcErc20.allowance(owner, CROSS_BUY_ROUTER_ADDRESS)) as bigint;
          if (allowance < usdcIn) {
            setTradeStage("approval");
            setStatus("Approve USDC spending in your wallet.");
            await (await usdcErc20.approve(CROSS_BUY_ROUTER_ADDRESS, usdcIn)).wait();
          }
          const router = new Contract(
            CROSS_BUY_ROUTER_ADDRESS,
            ["function buyWithUsdc(address,uint256,uint256,uint64) returns(uint256)"],
            signer,
          );
          tx = await router.buyWithUsdc(venueAddress, usdcIn, minOut, deadline);
        } else if (isEurc) {
          // Priced in EURC: approve the 6-dec EURC input, then buy(quoteIn, minTokensOut, deadline).
          const quoteIn = amountWei / QSCALE;
          if (quoteIn <= 0n) throw new Error("Amount too small for EURC (min 0.000001).");
          const eurc = new Contract(ARC_EURC_ADDRESS, erc20Abi, signer);
          const allowance = (await eurc.allowance(owner, venueAddress)) as bigint;
          if (allowance < quoteIn) {
            setTradeStage("approval");
            setStatus("Approve EURC spending in your wallet.");
            await (await eurc.approve(venueAddress, quoteIn)).wait();
          }
          tx = await curve.buy(quoteIn, minOut, deadline);
        } else {
          tx = await curve.buy(minOut, deadline, { value: amountWei });
        }
      } else {
        if (amountWei > balance) throw new Error("Token balance is too low.");
        const token = new Contract(asset.address, erc20Abi, signer);
        const allowance = (await token.allowance(owner, venueAddress)) as bigint;
        if (allowance < amountWei) {
          setTradeStage("approval");
          setStatus("Approve the exact sell amount in your wallet.");
          await (await token.approve(venueAddress, amountWei)).wait();
        }
        // EURC sell returns 6-dec collateral; scale the normalized minOut back down.
        const sellMinOut = isEurc ? minOut / QSCALE : minOut;
        tx = await curve.sell(amountWei, sellMinOut, deadline);
      }
      setTradeStage("submitted");
      setTxHash(tx.hash);
      writeActivity({ id: tx.hash, account, kind: side === "buy" ? "BUY" : "SELL", status: "submitted", title: `${side === "buy" ? "Buy" : "Sell"} ${asset.symbol}`, detail: `${amount} ${side === "buy" ? currency : asset.symbol} · ${graduated ? "ARC DEX" : "Bonding curve"}`, txHash: tx.hash, chainIn: "Arc_Testnet", chainOut: "Arc_Testnet", rail: "arc", createdAt: Date.now(), updatedAt: Date.now() });
      setStatus("Transaction submitted. Waiting for Arc confirmation…");
      await tx.wait();
      patchActivity(tx.hash, { status: "completed", detail: `${side === "buy" ? "Buy" : "Sell"} confirmed on Arc Testnet` });
      optimisticTapeUntil.current = Date.now() + 15_000;
      setLiveTrades((current) => [{ side: (side === "buy" ? "BUY" : "SELL") as "BUY" | "SELL", amount: amountWei, tokens: freshQuote }, ...current].slice(0, 12));
      const confirmedSide: "BUY" | "SELL" = side === "buy" ? "BUY" : "SELL";
      setChartTrades((current) => [...current, { side: confirmedSide, block: Number.MAX_SAFE_INTEGER, timestamp: Math.floor(Date.now() / 1000), tx: tx.hash, user: account, native: amountWei.toString(), tokens: freshQuote.toString() }].slice(-500));
      const confirmedBalance = await tokenReader.balanceOf(account) as bigint;
      await refreshOnchain(provider);
      setBalance(confirmedBalance);
      setTradeStage("confirmed");
      setStatus("Trade confirmed on Arc Testnet.");
    } catch (error) {
      setTradeStage("error");
      const raw = error instanceof Error ? error.message : String(error);
      const normalized = raw.toLowerCase();
      setStatus(
        normalized.includes("user rejected") || normalized.includes("user denied") || normalized.includes("action_rejected")
          ? "Transaction cancelled in wallet."
          : normalized.includes("request limit") || normalized.includes("missing revert data") || normalized.includes("could not coalesce")
            ? "Arc RPC is busy. No funds were sent—please wait a few seconds and try again."
            : normalized.includes("insufficient funds")
              ? `${currency} balance is too low to cover this trade and network fee.`
              : normalized.includes("slippage")
                ? "Price changed beyond your slippage limit. Refresh the quote or increase slippage slightly."
                : normalized.includes("curve_closed") || normalized.includes("bad_swap")
                  ? "This market has changed venue. Refresh the page before trading again."
                  : normalized.includes("no_liquidity")
                    ? "This market does not currently have enough liquidity for that amount."
                    : "Trade simulation failed. No funds were sent—refresh the quote and try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  const pct = graduated ? 100 : Math.min(100, Number((reserve * 10000n) / asset.threshold) / 100);
  const positionInput = graduated ? (balance * 9975n) / 10000n : balance;
  const sellValue = balance && inventory
    ? graduated
      ? (((x * positionInput) / (inventory + positionInput)) * 9995n) / 10000n
      : ((x - (x * inventory) / (inventory + balance)) * 99n) / 100n
    : 0n;
  const pnl = sellValue - netCost;
  const marketCap = inventory
    ? (x * 1_000_000_000_000_000_000_000_000_000n) / inventory
    : 0n;
  // Constant-product pairs hold equal value on both sides. `reserve` is the
  // normalized quote side, so Dexscreener-style pool liquidity is 2x quote.
  const dexLiquidity = graduated ? reserve * 2n : reserve;
  const burnedPct = asset.lpSupply && BigInt(asset.lpSupply) > 0n
    ? Number((BigInt(asset.lpBurned || "0") * 10_000n) / BigInt(asset.lpSupply)) / 100
    : 0;
  const tradePrices = chartTrades.slice(-500).map((trade) => ({ timestamp: trade.timestamp || trade.block, price: Number(BigInt(trade.native)) / Math.max(1, Number(BigInt(trade.tokens))), volume: Number(formatEther(BigInt(trade.native))) }));
  const candleMap = new Map<number, Array<{price:number;volume:number}>>();
  for (const point of tradePrices) { const bucket = Math.floor(point.timestamp / timeframe) * timeframe; candleMap.set(bucket, [...(candleMap.get(bucket) || []), {price:point.price,volume:point.volume}]); }
  const candles = [...candleMap.entries()].sort(([a], [b]) => a - b).slice(-chartWindow).map(([time, points]) => { const prices=points.map(point=>point.price); return { time, open: prices[0], close: prices[prices.length - 1], high: Math.max(...prices), low: Math.min(...prices), volume: points.reduce((sum,point)=>sum+point.volume,0) }; });
  const visibleCandles = candles;
  const chartLow = Math.min(...(visibleCandles.length ? visibleCandles.map((candle) => candle.low) : [0]));
  const chartHigh = Math.max(...(visibleCandles.length ? visibleCandles.map((candle) => candle.high) : [1]));
  const chartPad = (chartHigh - chartLow || chartHigh * .04 || 1) * .18;
  const chartFloor = Math.max(0, chartLow - chartPad), chartCeil = chartHigh + chartPad, chartSpan = chartCeil - chartFloor || 1;
  const candleY = (price: number) => 225 - ((price - chartFloor) / chartSpan) * 185;
  const lastPrice = tradePrices.at(-1)?.price || (inventory ? Number(x) / Number(inventory) : 0);
  const averageExecutionPrice = quote > 0n && amountWei > 0n ? side === "buy" ? Number(amountWei) / Number(quote) : Number(quote) / Number(amountWei) : 0;
  const priceImpact = lastPrice > 0 && averageExecutionPrice > 0 ? Math.abs(averageExecutionPrice - lastPrice) / lastPrice * 100 : 0;
  const priceLabel = (price: number) => price > 0 && price < .000001 ? price.toFixed(12).replace(/0+$/, "") : price.toLocaleString(undefined, { maximumFractionDigits: 8 });
  useEffect(() => {
    fetch(`/api/community.php?token=${encodeURIComponent(asset.address)}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then(async (payload: { posts?: CommunityPost[] }) => {
        const verified = await Promise.all((payload.posts || []).map(async (post) => {
          try {
            const recovered = verifyMessage(communitySigningMessage(post.token, post.message, post.timestamp), post.signature);
            return recovered.toLowerCase() === post.author.toLowerCase() ? post : null;
          } catch { return null; }
        }));
        setPosts(verified.filter((post): post is CommunityPost => post !== null));
      })
      .catch(() => setPosts([]));
  }, [asset.address]);
  useEffect(() => {
    fetch(`/api/social.php?token=${encodeURIComponent(asset.address)}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((payload: { social?: SocialLinks }) => {
        const social = payload.social;
        if (!social) { setSocials(null); return; }
        const recovered = verifyMessage(socialSigningMessage(social.token, social.twitter, social.discord, social.timestamp), social.signature);
        const creatorMatches = !asset.creator || recovered.toLowerCase() === asset.creator.toLowerCase();
        setSocials(recovered.toLowerCase() === social.creator.toLowerCase() && creatorMatches ? social : null);
      })
      .catch(() => setSocials(null));
  }, [asset.address, asset.creator]);
  async function publishPost() {
    const message = postText.trim();
    if (!account || !activeProvider) { connect(); return; }
    if (message.length < 2 || message.length > 280) { setStatus("Community post must be 2–280 characters."); return; }
    setPosting(true);
    try {
      const timestamp = Math.floor(Date.now() / 1000);
      const signer = await new BrowserProvider(activeProvider).getSigner();
      const author = await signer.getAddress();
      const signature = await signer.signMessage(communitySigningMessage(asset.address, message, timestamp));
      const response = await fetch("/api/community.php", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: asset.address, author, message, timestamp, signature }) });
      const payload = await response.json() as { post?: CommunityPost; error?: string };
      if (!response.ok || !payload.post) throw new Error(payload.error || "Post rejected");
      setPosts((current) => [payload.post!, ...current].slice(0, 100));
      setPostText("");
      setStatus("Signed community post published.");
    } catch (error) { setStatus(error instanceof Error ? error.message : "Post failed"); }
    finally { setPosting(false); }
  }
  async function shareCoin() {
    const url = new URL(window.location.href);
    if (account) url.searchParams.set("ref", account);
    const data = { title: `${asset.name} (${asset.symbol}) on Arcodian`, text: `${asset.symbol} · ${asset.progress.toFixed(2)}% to graduation · Track it on Arcodian`, url: url.toString() };
    if (navigator.share) await navigator.share(data);
    else { await navigator.clipboard.writeText(url.toString()); setStatus(account ? "Referral-attributed coin link copied." : "Coin link copied."); }
  }
  function openShareCard() {
    window.open(`/api/share-card.php?token=${encodeURIComponent(asset.address)}`, "_blank", "noopener,noreferrer");
  }
  async function submitReport() {
    try {
      const response = await fetch("/api/report.php", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: asset.address, category: reportCategory, detail: reportDetail.trim() }) });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Report rejected");
      setReportOpen(false); setReportDetail(""); setStatus("Report recorded for review. The market remains visible while evidence is assessed.");
    } catch (error) { setStatus(error instanceof Error ? error.message : "Report failed"); }
  }
  return (
    <section className="coin-page-shell">
      <div className="trade-desk coin-route">
        <button className="coin-back" onClick={close}>
          ← Back to market
        </button>
        <div className="coin-route-actions">
          <a href="/contracts">Verify contracts</a>
          <button onClick={() => void shareCoin()}>Share ↗</button>
          <button onClick={openShareCard}>Share card</button>
          <button onClick={() => setReportOpen((value) => !value)}>Report token</button>
        </div>
        {reportOpen && <div className="report-panel"><div><strong>Report ${asset.symbol}</strong><small>Reports do not freeze a market. Include only verifiable concerns.</small></div><select value={reportCategory} onChange={(event) => setReportCategory(event.target.value)}><option value="scam">Suspected scam</option><option value="impersonation">Impersonation</option><option value="harmful-link">Harmful social link</option><option value="illegal">Illegal content</option><option value="other">Other</option></select><textarea maxLength={240} value={reportDetail} onChange={(event) => setReportDetail(event.target.value)} placeholder="Optional evidence or context (max 240 characters)"/><div><button onClick={() => setReportOpen(false)}>Cancel</button><button className="primary" onClick={() => void submitReport()}>Submit report</button></div></div>}
        <div className="trade-identity">
          <img src={asset.image ? imageUrl(asset.image) : ""} alt="" />
          <div>
            <p className="kicker">{graduated ? "Graduated · trading on ARC DEX" : "Bonding curve market"} · Engine v{asset.engineVersion || 5}</p>
            <div className="venue-badges">
              {graduated && pair && <span className="live">● Arcodian DEX Live</span>}
              {asset.uniswapPool
                ? <a className="live" href={`${ARC.explorer}/address/${asset.uniswapPool}`} target="_blank" rel="noreferrer">● Uniswap Live ↗</a>
                : graduated && <span className="pending">Uniswap · awaiting official Arc deployment</span>}
            </div>
            <h3>
              {asset.name} <span>${asset.symbol}</span>
            </h3>
            <a
              href={`${ARC.explorer}/address/${asset.address}`}
              target="_blank"
              rel="noreferrer"
            >
              Contract {asset.address} ↗
            </a>
            {socials && (socials.twitter || socials.discord) && (
              <div className="coin-socials">
                {socials.twitter && <a href={socials.twitter} target="_blank" rel="noreferrer noopener">X / Twitter ↗</a>}
                {socials.discord && <a href={socials.discord} target="_blank" rel="noreferrer noopener">Discord ↗</a>}
              </div>
            )}
          </div>
        </div>
        <div className="terminal-ticker" aria-label="Live market snapshot">
          <span className="terminal-symbol"><i className={tapeHealth === "live" ? "live" : ""} />{asset.symbol} / {currency}<small>{graduated ? "ARCODIAN DEX" : "BONDING CURVE"}</small></span>
          <span><small>Last price</small><b>{priceLabel(lastPrice)} {currency}</b></span>
          <span className={(asset.priceChange24h || 0) >= 0 ? "positive" : "negative"}><small>24h change</small><b>{(asset.priceChange24h || 0) >= 0 ? "+" : ""}{(asset.priceChange24h || 0).toFixed(2)}%</b></span>
          <span><small>Market cap</small><b>{Number(formatEther(marketCap)).toLocaleString(undefined,{maximumFractionDigits:2})} {currency}</b></span>
          <span><small>DEX liquidity</small><b>{Number(formatEther(dexLiquidity)).toLocaleString(undefined,{maximumFractionDigits:2})} {currency}</b></span>
          <span className="terminal-network"><small>Feed</small><b>{tapeHealth === "live" ? "LIVE · 750ms" : tapeHealth.toUpperCase()}</b></span>
        </div>
        <div className={`market-lifecycle ${graduated && pair ? "dex" : "curve"}`}>
          <div>
            <small>{graduated && pair ? "Market lifecycle · Phase 02" : "Market lifecycle · Phase 01"}</small>
            <strong>{graduated && pair ? "Trading live on Arcodian DEX" : "Price discovery on bonding curve"}</strong>
            <p>{graduated && pair ? "Curve complete. Liquidity is permanent and every trade routes through the canonical pair." : `${asset.progress.toFixed(2)}% funded · graduates automatically at ${Number(formatEther(asset.threshold)).toLocaleString()} ${currency}.`}</p>
          </div>
          {graduated && pair ? <>
            <span><small>Canonical pair</small><a href={`${ARC.explorer}/address/${pair}`} target="_blank" rel="noreferrer">{short(pair)} ↗</a></span>
            <span><small>LP status</small><b>{burnedPct >= 99.99 ? `${burnedPct.toFixed(4)}% burned` : "Verify onchain"}</b></span>
            <span><small>DEX liquidity</small><b>{Number(formatEther(dexLiquidity)).toLocaleString(undefined, { maximumFractionDigits: 2 })} {currency}</b></span>
          </> : <>
            <span><small>Raised</small><b>{Number(formatEther(reserve)).toLocaleString(undefined,{maximumFractionDigits:2})} {currency}</b></span>
            <span><small>Remaining</small><b>{Number(formatEther(asset.threshold > reserve ? asset.threshold - reserve : 0n)).toLocaleString(undefined,{maximumFractionDigits:2})} {currency}</b></span>
            <span className="lifecycle-progress"><small>Graduation</small><b>{asset.progress.toFixed(2)}%</b><i><em style={{width:`${Math.min(100,asset.progress)}%`}}/></i></span>
          </>}
        </div>
        <div className="trade-layout">
          <div className={`chart-panel ${chartFullscreen ? "chart-fullscreen" : ""}`}>
            <div className="chart-head">
              <div><span>Candlestick · price per {asset.symbol}</span><div className="chart-timeframes">{([[60,"1m"],[300,"5m"],[900,"15m"],[3600,"1h"]] as const).map(([seconds,label])=><button key={seconds} className={timeframe===seconds?"active":""} onClick={()=>{setTimeframe(seconds);setChartHover(null)}}>{label}</button>)}</div></div>
              <div className="chart-tools"><b>{priceLabel(lastPrice)} {currency}</b><button onClick={()=>setChartWindow(value=>value===30?60:30)}>{chartWindow===30?"Zoom out":"Zoom in"}</button><button onClick={()=>setChartFullscreen(value=>!value)}>{chartFullscreen?"Exit":"Fullscreen"}</button></div>
            </div>
            <div className={`hero-chart ${visibleCandles.length ? "has-data" : "is-empty"}`} onMouseLeave={()=>setChartHover(null)} onMouseMove={(event)=>{if(!visibleCandles.length)return;const rect=event.currentTarget.getBoundingClientRect();setChartHover(Math.max(0,Math.min(visibleCandles.length-1,Math.floor(((event.clientX-rect.left)/rect.width)*visibleCandles.length))))}}>
              {!visibleCandles.length && <div className="chart-empty-state"><i>⌁</i><strong>Waiting for market activity</strong><small>The first confirmed buy or sell will create a candle here automatically.</small></div>}
              {chartHover!==null&&visibleCandles[chartHover]&&<div className="chart-tooltip"><b>{new Date(visibleCandles[chartHover].time*1000).toLocaleString()}</b><span>O {priceLabel(visibleCandles[chartHover].open)}</span><span>H {priceLabel(visibleCandles[chartHover].high)}</span><span>L {priceLabel(visibleCandles[chartHover].low)}</span><span>C {priceLabel(visibleCandles[chartHover].close)}</span><span>Vol {visibleCandles[chartHover].volume.toLocaleString(undefined,{maximumFractionDigits:4})} {currency}</span></div>}
              <svg viewBox="0 0 600 260" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="#b9ff45" stopOpacity=".35" />
                    <stop offset="1" stopColor="#b9ff45" stopOpacity="0" />
                  </linearGradient>
                </defs>
                {[0, .25, .5, .75, 1].map((ratio) => <line key={ratio} x1="0" x2="600" y1={40 + ratio * 185} y2={40 + ratio * 185} stroke="#b8cce022" strokeWidth="1" />)}
                {visibleCandles.length ? visibleCandles.map((candle, index) => {
                  const xPos = ((index + .5) / visibleCandles.length) * 540 + 10;
                  const width = Math.max(5, Math.min(18, 430 / visibleCandles.length));
                  const up = candle.close >= candle.open;
                  const top = candleY(Math.max(candle.open, candle.close));
                  const bottom = candleY(Math.min(candle.open, candle.close));
                  return <g key={`${candle.time}-${index}`}><line x1={xPos} x2={xPos} y1={candleY(candle.high)} y2={candleY(candle.low)} stroke={up ? "#0bbf9a" : "#ef5570"} strokeWidth="2"/><rect x={xPos - width / 2} y={top} width={width} height={Math.max(3, bottom - top)} rx="1" fill={up ? "#0bbf9a" : "#ef5570"}/></g>;
                }) : null}
                {chartHover!==null&&visibleCandles.length>0&&<line x1={((chartHover+.5)/visibleCandles.length)*540+10} x2={((chartHover+.5)/visibleCandles.length)*540+10} y1="30" y2="230" stroke="#d9ff9b" strokeDasharray="4 4"/>}
                <text x="592" y="34" textAnchor="end" fill="#405a80" fontSize="11" fontWeight="600">{priceLabel(chartCeil)}</text>
                <text x="592" y="239" textAnchor="end" fill="#405a80" fontSize="11" fontWeight="600">{priceLabel(chartFloor)}</text>
              </svg>
            </div>
            <div className="market-metrics">
              <span>
                <small>Market cap</small>
                <b>
                  {Number(formatEther(marketCap)).toLocaleString(undefined, {
                    maximumFractionDigits: 2,
                  })}{" "}
                  {currency}
                </b>
              </span>
              <span>
                <small>{graduated ? "DEX liquidity" : "Raised / target"}</small>
                <b>{graduated
                  ? `${Number(formatEther(dexLiquidity)).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${currency}`
                  : `${Number(formatEther(reserve)).toLocaleString(undefined, { maximumFractionDigits: 4 })} / ${Number(formatEther(asset.threshold)).toLocaleString()}`}
                </b>
              </span>
              <span>
                <small>Indexed volume / trades</small>
                <b>{asset.volume ? Number(formatEther(BigInt(asset.volume))).toLocaleString(undefined, { maximumFractionDigits: 3 }) : "0"} {currency} · {asset.tradeCount || 0}</b>
              </span>
              <span>
                <small>Your position</small>
                <b>
                  {Number(formatEther(sellValue)).toLocaleString(undefined, {
                    maximumFractionDigits: 4,
                  })}{" "}
                  {currency}
                </b>
              </span>
              <span className={pnl >= 0n ? "positive" : "negative"}>
                <small>Unrealized P/L</small>
                <b>
                  {pnl >= 0n ? "+" : ""}
                  {Number(formatEther(pnl)).toLocaleString(undefined, {
                    maximumFractionDigits: 4,
                  })}{" "}
                  {currency}
                </b>
              </span>
            </div>
            <div className="desk-tabs" role="tablist" aria-label="Market data sections">
              {(["trades", "holders", "community"] as const).map((section) => (
                <button key={section} role="tab" aria-selected={deskTab === section} className={deskTab === section ? "active" : ""} onClick={() => setDeskTab(section)}>
                  {section === "trades" ? "Trades" : section === "holders" ? `Holders (${asset.holderCount || 0})` : `Community (${posts.length})`}
                </button>
              ))}
            </div>
            {deskTab === "trades" && <div className="live-trades">
              <div className="live-trades-head">
                <strong><i /> Live trades</strong>
                <small>Indexed tape · {tapeHealth === "live" ? "live" : tapeHealth === "delayed" ? "delayed" : "temporarily offline"}</small>
              </div>
              {liveTrades.length ? (
                liveTrades.map((event, index) => (
                  <span key={`${event.side}-${index}`}>
                    <b
                      className={event.side === "BUY" ? "positive" : "negative"}
                    >
                      {event.side}
                    </b>
                    <i>
                      {Number(formatEther(event.amount)).toLocaleString(
                        undefined,
                        { maximumFractionDigits: 4 },
                      )}{" "}
                      USDC
                    </i>
                    <small>
                      {Number(formatEther(event.tokens)).toLocaleString(
                        undefined,
                        { maximumFractionDigits: 2 },
                      )}{" "}
                      {asset.symbol}
                    </small>
                  </span>
                ))
              ) : (
                <p>No trades yet.</p>
              )}
            </div>}
            {deskTab === "holders" && <div className="holder-analytics">
              <div className="section-title"><strong>Holder analytics</strong><small>Balances among indexed onchain participants</small></div>
              <div className="holder-summary"><span><small>Indexed holders</small><b>{asset.holderCount || 0}</b></span><span><small>Creator</small><b>{asset.creator ? short(asset.creator) : "Unknown"}</b></span><span><small>24h volume</small><b>{Number(formatEther(BigInt(asset.volume24h || "0"))).toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC</b></span></div>
              <div className="holder-list">
                {(asset.topHolders || []).slice(0, 5).map((holder, index) => <span key={holder.address}><i>#{index + 1}</i><a href={`${ARC.explorer}/address/${holder.address}`} target="_blank" rel="noreferrer">{short(holder.address)}</a><b>{Number(formatEther(BigInt(holder.balance))).toLocaleString(undefined, { maximumFractionDigits: 2 })} {asset.symbol}</b></span>)}
                {!asset.topHolders?.length && <p>Holder distribution appears after indexed trades.</p>}
              </div>
            </div>}
            {deskTab === "community" && <div className="community-panel">
              <div className="section-title"><strong>Community</strong><small>Wallet-signed public posts</small></div>
              <div className="community-compose">
                <textarea maxLength={280} placeholder={account ? `Share a note about ${asset.symbol}…` : "Connect wallet to post"} value={postText} onChange={(event) => setPostText(event.target.value)} />
                <button disabled={posting || !postText.trim()} onClick={() => void publishPost()}>{posting ? "Signing…" : account ? "Sign & post" : "Connect"}</button>
              </div>
              <div className="community-feed">
                {posts.map((post) => <article key={post.id}><div><a href={`${ARC.explorer}/address/${post.author}`} target="_blank" rel="noreferrer">{short(post.author)}</a><time>{new Date(post.timestamp * 1000).toLocaleString()}</time></div><p>{post.message}</p></article>)}
                {!posts.length && <p>No signed community posts yet.</p>}
              </div>
            </div>}
          </div>
          <div className="order-panel" id="trade-order-panel">
            <div className="risk-notice">
              <strong>Permissionless market</strong>
              <small>Anyone can create a token. Verify the contract and never trade more than you can afford to lose.</small>
            </div>
            <div className="side-tabs">
              <button
                className={side === "buy" ? "active" : ""}
                onClick={() => { setSide("buy"); setAmount("1"); setTradeStage("idle"); setStatus(""); setTxHash(""); }}
              >
                Buy
              </button>
              <button
                className={side === "sell" ? "active" : ""}
                onClick={() => { setSide("sell"); setAmount(""); setTradeStage("idle"); setStatus(""); setTxHash(""); }}
              >
                Sell
              </button>
            </div>
            <label>
              {side === "buy" ? "Pay USDC" : "Sell tokens"}
              <input
                inputMode="decimal"
                value={amount}
                onChange={(e) => { setAmount(e.target.value.replace(/[^0-9.]/g, "")); setTradeStage("idle"); setStatus(""); setTxHash(""); }}
              />
              <strong>{side === "buy" ? "USDC" : asset.symbol}</strong>
            </label>
            <div className="trade-presets" aria-label={side === "buy" ? "Quick buy amounts" : "Quick sell percentages"}>
              {side === "buy"
                ? ["25", "100", "500", "1000"].map((value) => <button key={value} onClick={() => { setAmount(value); setTradeStage("idle"); setStatus(""); }}>{value} USDC</button>)
                : [["25%", 25n], ["50%", 50n], ["75%", 75n], ["MAX", 100n]].map(([label, percentage]) => <button key={String(label)} onClick={() => { setAmount(formatEther((balance * BigInt(percentage)) / 100n)); setTradeStage("idle"); setStatus(""); }}>{String(label)}</button>)}
            </div>
            {side === "sell" && (
              <button
                className="max-button"
                onClick={() => setAmount(formatEther(balance))}
              >
                Balance{" "}
                {Number(formatEther(balance)).toLocaleString(undefined, {
                  maximumFractionDigits: 4,
                })}{" "}
                · MAX
              </button>
            )}
            <div className="slippage">
              <span>Slippage</span>
              {["0.5", "1", "3"].map((v) => (
                <button
                  key={v}
                  className={slippage === v ? "active" : ""}
                  onClick={() => setSlippage(v)}
                >
                  {v}%
                </button>
              ))}
            </div>
            <div className="trade-quote">
              <span>{side === "buy" ? `You receive ${asset.symbol}` : "You receive USDC"}</span>
              <b>
                {Number(formatEther(quote)).toLocaleString(undefined, {
                  maximumFractionDigits: 6,
                })}{" "}
                {side === "buy" ? asset.symbol : "USDC"}
              </b>
              <div className="quote-ledger">
                <span><small>Minimum received</small><b>{Number(formatEther(minimumReceived)).toLocaleString(undefined,{maximumFractionDigits:6})} {side === "buy" ? asset.symbol : "USDC"}</b></span>
                <span><small>Venue fee</small><b>{venueFeeLabel}</b></span>
                <span><small>Deadline</small><b>10 minutes</b></span>
              </div>
              {side === "buy" && (
                <CostLine
                  cost={cost}
                  holding={holdingCurrency}
                  quoteCurrency={currencyOf(asset)}
                  tokensOut={Number(formatEther(quote)).toLocaleString(undefined, { maximumFractionDigits: 4 })}
                  symbol={asset.symbol}
                />
              )}
              <div className="execution-preview"><span><small>Average execution</small><b>{priceLabel(averageExecutionPrice)} USDC / {asset.symbol}</b></span><span className={priceImpact>5?"warning":""}><small>Estimated price impact</small><b>{priceImpact.toLocaleString(undefined,{maximumFractionDigits:2})}%</b></span></div>
            </div>
            {insufficientBalance && <p className="inline-error">Sell amount exceeds your {asset.symbol} balance.</p>}
            {status && <p className="status">{status}</p>}
            {txHash && <a className="tx-link" href={`${ARC.explorer}/tx/${txHash}`} target="_blank" rel="noreferrer">View transaction {short(txHash)} ↗</a>}
            {tradeStage !== "idle" && <div className={`trade-progress ${tradeStage}`} aria-live="polite">
              <span className={["quote","approval","submitted","confirmed"].includes(tradeStage) ? "done" : ""}>1 <small>Quote</small></span>
              <span className={["approval","submitted","confirmed"].includes(tradeStage) ? "done" : ""}>2 <small>{side === "sell" ? "Approval" : "Wallet"}</small></span>
              <span className={["submitted","confirmed"].includes(tradeStage) ? "done" : ""}>3 <small>Onchain</small></span>
              <span className={tradeStage === "confirmed" ? "done" : ""}>4 <small>Confirmed</small></span>
            </div>}
            <button
              className="primary"
              disabled={busy || !validAmount || quote <= 0n || insufficientBalance}
              onClick={trade}
            >
              {!account
                ? "Connect wallet"
                : busy
                  ? tradeStage === "submitted" ? "Confirming onchain…" : tradeStage === "approval" ? "Approve in wallet…" : "Confirm in wallet…"
                  : `${side === "buy" ? "Buy" : "Sell"} ${asset.symbol}`}
            </button>
            <p className="fine">
              Exact approval only · wallet-signed · non-custodial
            </p>
          </div>
        </div>
        <div className="mobile-trade-dock">
          <span><small>{side === "buy" ? "Estimated receive" : "Estimated output"}</small><b>{Number(formatEther(quote)).toLocaleString(undefined,{maximumFractionDigits:4})} {side === "buy" ? asset.symbol : "USDC"}</b></span>
          <button onClick={() => document.getElementById("trade-order-panel")?.scrollIntoView({ behavior: "smooth", block: "center" })}>{side === "buy" ? "Buy" : "Sell"} {asset.symbol}</button>
        </div>
      </div>
    </section>
  );
}

function Launch({
  account,
  activeProvider,
  connect,
  onCreated,
}: {
  account: string;
  activeProvider: EthereumProvider | null;
  connect: () => void;
  onCreated?: (asset: LaunchAsset) => void;
}) {
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [image, setImage] = useState("");
  const [twitter, setTwitter] = useState("");
  const [discord, setDiscord] = useState("");
  const [quoteChoice, setQuoteChoice] = useState<"USDC" | "EURC">("USDC");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const launchStep = !name.trim() || !symbol.trim() ? 1 : !image ? 2 : 3;
  const identityReady = Boolean(name.trim() && /^[A-Za-z0-9]{2,10}$/.test(symbol));
  const launchReady = identityReady && /^https:\/\//.test(image);

  async function uploadImage(file: File) {
    setBusy(true);
    setStatus("Resizing and converting image to compact WebP…");
    try {
      const body = new FormData();
      body.append("image", file);
      const response = await fetch("/api/upload-image.php", {
        method: "POST",
        body,
      });
      const result = (await response.json()) as {
        url?: string;
        bytes?: number;
        error?: string;
      };
      if (!response.ok || !result.url)
        throw new Error(result.error || "Image upload failed");
      setImage(result.url);
      setStatus(
        `Image ready · ${Math.ceil((result.bytes || 0) / 1024)} KB WebP`,
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Image upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function createPumpLaunch() {
    if (!activeProvider) {
      connect();
      return;
    }
    const twitterUrl = normalizeSocial(twitter, "twitter");
    const discordUrl = normalizeSocial(discord, "discord");
    if ((twitter.trim() && !twitterUrl) || (discord.trim() && !discordUrl)) {
      setStatus("Use a valid x.com/twitter.com or discord.gg/discord.com link.");
      return;
    }
    if (
      !name.trim() ||
      !/^[A-Za-z0-9]{2,10}$/.test(symbol) ||
      !/^https:\/\//.test(image)
    ) {
      setStatus(
        "Enter name, 2–10 character symbol, and upload a valid image first.",
      );
      return;
    }
    setBusy(true);
    setStatus(
      "Switching to Arc Testnet. Review the fixed-1B image launch in your wallet.",
    );
    try {
      try {
        await activeProvider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: ARC.hexId }],
        });
      } catch (switchError) {
        if ((switchError as { code?: number }).code !== 4902) throw switchError;
        await activeProvider.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: ARC.hexId,
              chainName: ARC.name,
              nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
              rpcUrls: [ARC.rpc],
              blockExplorerUrls: [ARC.explorer],
            },
          ],
        });
      }
      const provider = new BrowserProvider(activeProvider as never);
      const signer = await provider.getSigner();
      const isEurc = quoteChoice === "EURC";
      const factory = new Contract(
        isEurc ? EURC_PUMP_FACTORY_ADDRESS : PUMP_FACTORY_ADDRESS,
        ARC_PUMP_FACTORY_ABI,
        signer,
      );
      const tx = await factory.createLaunch(
        name.trim(),
        symbol.toUpperCase(),
        image,
      );
      setStatus(`Launch submitted: ${tx.hash}`);
      const receipt = await tx.wait();
      const created = receipt.logs
        .map((log: { topics: readonly string[]; data: string }) => {
          try {
            return factory.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((log: { name?: string } | null) => log?.name === "LaunchCreated");
      setStatus(
        created
          ? `Launch created · Token ${created.args.token} · Curve ${created.args.curve}`
          : `Launch confirmed: ${receipt.hash}`,
      );
      if (created) {
        const tokenAddress = String(created.args.token);
        const curveAddress = String(created.args.curve);
        if (twitterUrl || discordUrl) {
          try {
            const timestamp = Math.floor(Date.now() / 1000);
            const creator = await signer.getAddress();
            const signature = await signer.signMessage(socialSigningMessage(tokenAddress, twitterUrl, discordUrl, timestamp));
            const response = await fetch("/api/social.php", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: tokenAddress, creator, twitter: twitterUrl, discord: discordUrl, timestamp, signature }) });
            if (!response.ok) throw new Error("Coin created, but social links could not be saved.");
          } catch (socialError) {
            setStatus(socialError instanceof Error ? socialError.message : "Coin created, but social links were skipped.");
          }
        }
        const QSCALE = 10n ** 12n;
        const curve = new Contract(curveAddress, [
          isEurc ? "function realQuoteReserve() view returns(uint256)" : "function realNativeReserve() view returns(uint256)",
          "function graduationThreshold() view returns(uint256)", "function graduated() view returns(bool)"], provider);
        const token = new Contract(tokenAddress, ["function balanceOf(address) view returns(uint256)"], provider);
        const [rawReserve, rawThreshold, graduated, inventory] = await Promise.all([
          isEurc ? curve.realQuoteReserve() : curve.realNativeReserve(),
          curve.graduationThreshold(), curve.graduated(), token.balanceOf(curveAddress)]);
        // Normalize EURC's 6-dec collateral to the 18-dec magnitudes the UI expects.
        const scale = isEurc ? QSCALE : 1n;
        // Canonical v9 fixes the virtual reserve at 1,000 quote units. Do not
        // call the legacy VIRTUAL_* getter here: v9 keeps its selector as a
        // reverting compatibility stub, which previously made a successful
        // create look failed during post-confirmation hydration.
        const reserve = (rawReserve as bigint) * scale, virtualReserve = 1_000n * 10n ** 18n, threshold = (rawThreshold as bigint) * scale;
        onCreated?.({ symbol: symbol.toUpperCase(), name: name.trim(), type: "Meme", risk: "Curve", address: tokenAddress, curve: curveAddress, image, creator: account, quoteKind: isEurc ? 1 : 0, currency: quoteChoice, progress: graduated ? 100 : Number((reserve * 10000n) / threshold) / 100, reserve, virtualReserve, threshold, inventory, graduated, tradeCount: 0, holderCount: 0, volume: "0", volume1h: "0", volume24h: "0", priceChange24h: 0, topHolders: [], trades: [] });
      }
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Launch creation rejected",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="launch-state">
      <div className="factory-proof">
        {/* Derived from ENGINE_VERSION rather than written by hand — this
            label read "v5" through the whole of v6 and v7. V8 has no suite
            contract, so the link points at the launch factory itself. */}
        <span>● Arcodian v{ENGINE_VERSION} market engine live</span>
        <a
          href={`${ARC.explorer}/address/${PUMP_FACTORY_ADDRESS}`}
          target="_blank"
          rel="noreferrer"
        >
          {short(PUMP_FACTORY_ADDRESS)} ↗
        </a>
      </div>
      <div className="studio-steps">
        <span className={launchStep >= 1 ? "active" : ""}><i>01</i><b>Identity</b><small>Name and ticker</small></span>
        <span className={launchStep >= 2 ? "active" : ""}><i>02</i><b>Media</b><small>Permanent image</small></span>
        <span className={launchStep >= 3 ? "active" : ""}><i>03</i><b>Review</b><small>Wallet launch</small></span>
      </div>
      <div className="launch-hero">
        <div>
          <p className="kicker">Launch studio · Arc testnet</p>
          <h3>Build the coin.<br/><em>We handle the market.</em></h3>
          <p>One wallet confirmation creates a fixed-supply token and its live bonding curve. At 4,500 {quoteChoice}, liquidity graduates automatically to ARC DEX.</p>
        </div>
        <span className="launch-network"><i/> Canonical v{ENGINE_VERSION}</span>
      </div>
      <div className="pump-flow">
        <span>
          <b>1</b> Fixed 1B supply
        </span>
        <span>
          <b>2</b> Bonding curve
        </span>
        <span>
          <b>3</b> Auto-graduate
        </span>
        <span>
          <b>4</b> LP → burn address
        </span>
      </div>
      <div className="launch-studio-workspace">
      <div className="launch-form">
        <div className="launch-section-title"><span>01</span><div><b>Token identity</b><small>Name your market</small></div><i className={identityReady ? "done" : ""}>{identityReady ? "✓" : "Required"}</i></div>
        <label>
          <span>Token name <i>Required</i></span>
          <input
            value={name}
            maxLength={40}
            onChange={(event) => setName(event.target.value)}
            placeholder="Arc Cat"
          />
        </label>
        <label>
          <span>Symbol <i>2–10 characters</i></span>
          <input
            value={symbol}
            maxLength={10}
            onChange={(event) =>
              setSymbol(event.target.value.replace(/[^A-Za-z0-9]/g, ""))
            }
            placeholder="ACAT"
          />
        </label>
        <label>
          <span>Quote asset <i>Trading currency</i></span>
          <div className="quote-toggle" role="group" aria-label="Quote asset">
            <button type="button" className={quoteChoice === "USDC" ? "active" : ""} onClick={() => setQuoteChoice("USDC")}>USDC</button>
            <button type="button" className={quoteChoice === "EURC" ? "active" : ""} onClick={() => setQuoteChoice("EURC")}>EURC</button>
          </div>
          <small>Traders buy/sell your coin in {quoteChoice}. Graduation at 4,500 {quoteChoice}.</small>
        </label>
        <div className="launch-section-title launch-section-social"><span>02</span><div><b>Community</b><small>Optional discovery links</small></div></div>
        <label>
          <span>X / Twitter <i>Optional</i></span>
          <input value={twitter} maxLength={120} onChange={(event) => setTwitter(event.target.value)} placeholder="@arcodian or x.com/arcodian" />
        </label>
        <label>
          <span>Discord <i>Optional</i></span>
          <input value={discord} maxLength={120} onChange={(event) => setDiscord(event.target.value)} placeholder="discord.gg/your-community" />
        </label>
        <div className="launch-section-title launch-section-media"><span>03</span><div><b>Token artwork</b><small>Square image · stored publicly</small></div><i className={image ? "done" : ""}>{image ? "✓" : "Required"}</i></div>
        <label className={`image-field ${image ? "has-image" : ""}`}>
          <span className="upload-icon">{image ? "✓" : "↑"}</span>
          <b>{image ? "Artwork ready" : "Upload token artwork"}</b>
          <small>PNG, JPG, WebP or GIF · auto-cropped to 512 × 512</small>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadImage(file);
            }}
          />
        </label>
        {image && (
          <div className="image-preview">
            <img src={imageUrl(image)} alt="Token preview" />
            <small>512×512 WebP · public URL recorded onchain</small>
          </div>
        )}
      </div>
      <aside className="launch-live-preview">
        <div className="preview-head"><p className="kicker">Market preview</p><span>Testnet</span></div>
        <div className="preview-token-art">{image ? <img src={imageUrl(image)} alt="" /> : <b>{symbol?.[0]?.toUpperCase() || "A"}</b>}</div>
        <h4>{name.trim() || "Your coin name"}</h4>
        <strong>${symbol.toUpperCase() || "TICKER"}</strong>
        <div className="preview-market-data"><span><small>Fixed supply</small><b>1,000,000,000</b></span><span><small>Launch venue</small><b>Bonding curve</b></span><span><small>Graduation</small><b>4,500 {quoteChoice}</b></span><span><small>Liquidity</small><b>Permanent</b></span></div>
        <div className="launch-readiness"><b>{launchReady ? "Ready to launch" : "Complete required fields"}</b><div><i className={identityReady ? "done" : ""}/><i className={image ? "done" : ""}/><i className={launchReady ? "done" : ""}/></div></div>
        <small className="preview-note">This is a visual preview. Contract addresses are created only after wallet confirmation.</small>
      </aside>
      </div>
      {status && <p className="status">{status}</p>}
      <div className="launch-submit">
      {!account ? (
        <button className="primary" onClick={connect}>
          Connect creator wallet
        </button>
      ) : (
        <button className="primary" disabled={busy || !launchReady} onClick={createPumpLaunch}>
          {busy ? "Creating on Arc Testnet…" : launchReady ? "Review & create coin →" : "Complete required fields"}
        </button>
      )}
      <small>Wallet-signed · non-custodial · testnet assets only</small>
      </div>
    </div>
  );
}

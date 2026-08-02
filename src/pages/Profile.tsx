import { useEffect, useState } from "react";
import { Contract, formatEther } from "ethers";
import { ARC, ARC_MAINNET, ARC_MAINNET_CONTRACTS, LEGACY_PUMP_FACTORY_ADDRESSES, PUMP_FACTORY_ADDRESS } from "../config";
import { ARC_PUMP_FACTORY_ABI } from "../generated/arcPumpFactory";
import { arcProvider, imageUrl, readActivities, short, type LaunchAsset, type WalletActivity } from "../shared";

// Module-level so the reference stays stable across renders — an inline
// array here would allocate fresh every render and (since the holdings
// effect depends on it) retrigger an infinite refetch loop, same failure
// mode fixed in Market.tsx.
const MAINNET_LEGACY_FACTORIES: string[] = [ARC_MAINNET_CONTRACTS.marketUsdcFactory];

export default function Profile({
  account,
  chainId,
  connect,
  chooseCoin,
}: {
  account: string;
  chainId?: number | null;
  connect: () => void;
  chooseCoin: (address: string) => void;
}) {
  // Same default-to-mainnet + V9-primary/V8-legacy split as Market.tsx —
  // this page was entirely testnet-hardcoded (index file, factories, even a
  // literal "Arc Testnet" label) until now, so a creator's real mainnet
  // holdings/launches (ARDN etc.) never showed up here at all.
  const isMainnet = chainId == null || chainId === ARC_MAINNET.id;
  const activeArc = isMainnet ? ARC_MAINNET : ARC;
  const activeFactory = isMainnet ? ARC_MAINNET_CONTRACTS.marketUsdcFactoryV9 : PUMP_FACTORY_ADDRESS;
  const activeLegacyFactories = isMainnet ? MAINNET_LEGACY_FACTORIES : LEGACY_PUMP_FACTORY_ADDRESSES;
  const [holdings, setHoldings] = useState<
    Array<LaunchAsset & { balance: bigint; value: bigint }>
  >([]);
  const [created, setCreated] = useState<LaunchAsset[]>([]);
  const [arenaRank, setArenaRank] = useState<number | null>(null);
  const [referralStats, setReferralStats] = useState({ visits: 0, uniqueVisitors: 0 });
  const [loading, setLoading] = useState(false);
  const [profileTab, setProfileTab] = useState<"holdings" | "created" | "activity" | "reputation">("holdings");
  const [activities, setActivities] = useState<WalletActivity[]>([]);
  const [activityVisible, setActivityVisible] = useState(20);
  useEffect(() => {
    if (!account) { setActivities([]); return; }
    let stopped = false;
    const refreshActivities = async () => {
      const wallet = account.toLowerCase();
      const local = readActivities().filter((item) => item.account.toLowerCase() === wallet && (item.kind === "BUY" || item.kind === "SELL"));
      try {
        const response = await fetch("/data/market-index.json", { cache: "no-store" });
        if (!response.ok) throw new Error("INDEX_UNAVAILABLE");
        const index = await response.json() as { launches?: Array<{ address: string; symbol: string; name: string; trades?: Array<{ side: "BUY" | "SELL"; block: number; timestamp?: number; tx: string; user: string; native: string; tokens: string }> }> };
        const indexed = (index.launches || []).flatMap((market) => (market.trades || [])
          .filter((trade) => trade.user.toLowerCase() === wallet)
          .map((trade): WalletActivity => ({
            id: trade.tx,
            account,
            kind: trade.side,
            status: "completed",
            title: `${trade.side === "BUY" ? "Buy" : "Sell"} ${market.symbol}`,
            detail: `${Number(formatEther(BigInt(trade.native))).toLocaleString(undefined, { maximumFractionDigits: 6 })} USDC · ${Number(formatEther(BigInt(trade.tokens))).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${market.symbol}`,
            txHash: trade.tx,
            chainIn: "Arc_Testnet",
            chainOut: "Arc_Testnet",
            rail: "arc",
            createdAt: (trade.timestamp || 0) * 1000,
            updatedAt: (trade.timestamp || 0) * 1000,
          })));
        const indexedKeys = new Set(indexed.map((item) => `${item.txHash?.toLowerCase()}:${item.kind}`));
        const optimistic = local.filter((item) => !indexedKeys.has(`${item.txHash?.toLowerCase()}:${item.kind}`));
        if (!stopped) setActivities([...optimistic, ...indexed].sort((a, b) => b.updatedAt - a.updatedAt));
      } catch {
        if (!stopped) setActivities(local.sort((a, b) => b.updatedAt - a.updatedAt));
      }
    };
    setActivityVisible(20);
    void refreshActivities();
    const handleRefresh = () => void refreshActivities();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refreshActivities(); }, 5_000);
    window.addEventListener("arcodian:activity", handleRefresh);
    window.addEventListener("storage", handleRefresh);
    return () => { stopped = true; window.clearInterval(timer); window.removeEventListener("arcodian:activity", handleRefresh); window.removeEventListener("storage", handleRefresh); };
  }, [account]);
  useEffect(() => {
    if (!account) { setReferralStats({ visits: 0, uniqueVisitors: 0 }); return; }
    fetch(`/api/referral.php?ref=${encodeURIComponent(account)}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((data: { visits?: number; uniqueVisitors?: number }) => setReferralStats({ visits: data.visits || 0, uniqueVisitors: data.uniqueVisitors || 0 }))
      .catch(() => setReferralStats({ visits: 0, uniqueVisitors: 0 }));
  }, [account]);
  useEffect(() => {
    if (!account) {
      setHoldings([]);
      return;
    }
    const provider = arcProvider(activeArc);
    setLoading(true);
    (async () => {
      const groups = await Promise.all(
        [activeFactory, ...activeLegacyFactories].map(
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
                const address = (await factory.tokenByLaunch(id)) as string;
                const curveAddress = (await factory.curveByLaunch(
                  id,
                )) as string;
                const token = new Contract(
                  address,
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
                  ],
                  provider,
                );
                const [name, symbol, balance, virtualReserve, threshold, graduated] = await Promise.all([
                  token.name(),
                  token.symbol(),
                  token.balanceOf(account),
                  curve.VIRTUAL_NATIVE(),
                  curve.graduationThreshold(),
                  curve.graduated(),
                ]);
                let reserve: bigint;
                let inventory: bigint;
                let pair = "";
                if (graduated) {
                  // V8 curves expose pair() (ArcPair v2-style); V9 curves
                  // expose pool() (a real Uniswap V3 pool) instead — same
                  // probe-both fix applied in Market.tsx, since calling the
                  // wrong one reverts and previously left this whole factory's
                  // graduated holdings unreadable.
                  try {
                    pair = await curve.pair();
                    const dexPair = new Contract(pair, ["function nativeReserve() view returns(uint256)", "function tokenReserve() view returns(uint256)"], provider);
                    [reserve, inventory] = await Promise.all([dexPair.nativeReserve(), dexPair.tokenReserve()]);
                  } catch {
                    const poolReader = new Contract(curveAddress, ["function pool() view returns(address)"], provider);
                    pair = await poolReader.pool();
                    const usdc = new Contract(activeArc.nativeToken, ["function balanceOf(address) view returns(uint256)"], provider);
                    [inventory, reserve] = await Promise.all([token.balanceOf(pair), usdc.balanceOf(pair)]);
                  }
                } else {
                  [reserve, inventory] = await Promise.all([curve.realNativeReserve(), token.balanceOf(curveAddress)]);
                }
                const walletBalance = BigInt(balance);
                const curveInventory = BigInt(inventory);
                const curveReserve = BigInt(reserve);
                const curveVirtualReserve = BigInt(virtualReserve);
                const curveThreshold = BigInt(threshold);
                if (walletBalance === 0n) return null;
                let image = "";
                try {
                  image = await token.imageURI();
                } catch {
                  image = "";
                }
                const x = graduated ? curveReserve : curveVirtualReserve + curveReserve;
                const positionInput = graduated ? (walletBalance * 9975n) / 10000n : walletBalance;
                const grossValue = curveInventory ? (x * positionInput) / (curveInventory + positionInput) : 0n;
                const value = graduated ? (grossValue * 9995n) / 10000n : (grossValue * 99n) / 100n;
                return {
                  address,
                  curve: curveAddress,
                  pair,
                  name,
                  symbol,
                  image,
                  balance: walletBalance,
                  value,
                  reserve: curveReserve,
                  virtualReserve: curveVirtualReserve,
                  threshold: curveThreshold,
                  inventory: curveInventory,
                  graduated,
                  progress: graduated
                    ? 100
                    : Number((curveReserve * 10000n) / curveThreshold) / 100,
                  type: graduated ? "Graduated" : "Meme",
                  risk: graduated ? "DEX live" : "Curve",
                } as LaunchAsset & { balance: bigint; value: bigint };
              }),
            );
          },
        ),
      );
      setHoldings(
        groups
          .flat()
          .filter(
            (item): item is LaunchAsset & { balance: bigint; value: bigint } =>
              item !== null,
          ),
      );
    })()
      .catch(() => setHoldings([]))
      .finally(() => {
        setLoading(false);
        provider.destroy();
      });
  }, [account, isMainnet, activeArc, activeFactory, activeLegacyFactories]);
  useEffect(() => {
    if (!account) { setCreated([]); return; }
    fetch(isMainnet ? "/data/mainnet-market-index.json" : "/data/market-index.json", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((index: { launches: Array<Record<string, unknown>>; arena?: { standings?: Array<{ token: string }> } }) => {
        const makerCoins = index.launches.filter((item) => String(item.creator || "").toLowerCase() === account.toLowerCase()).map((item) => {
        const reserve = BigInt(String(item.reserve)), virtualReserve = BigInt(String(item.virtualReserve)), threshold = BigInt(String(item.threshold)), inventory = BigInt(String(item.inventory));
        return { ...item, reserve, virtualReserve, threshold, inventory, type: item.graduated ? "Graduated" : "Meme", risk: item.graduated ? "DEX live" : "Curve", progress: item.graduated ? 100 : Number((reserve * 10000n) / threshold) / 100 } as LaunchAsset;
        });
        setCreated(makerCoins);
        const ranks = (index.arena?.standings || []).map((row) => row.token.toLowerCase());
        const best = makerCoins.map((coin) => ranks.indexOf(coin.address.toLowerCase())).filter((rank) => rank >= 0).sort((a,b) => a-b)[0];
        setArenaRank(best === undefined ? null : best + 1);
      })
      .catch(() => { setCreated([]); setArenaRank(null); });
  }, [account, isMainnet]);
  const total = holdings.reduce((sum, item) => sum + item.value, 0n);
  const creatorVolume = created.reduce((sum, item) => sum + BigInt(item.volume || "0"), 0n);
  const creatorHolders = created.reduce((sum, item) => sum + (item.holderCount || 0), 0);
  const graduatedCount = created.filter((item) => item.graduated).length;
  const reputationScore = Math.min(100, created.length * 10 + graduatedCount * 35 + Math.min(25, creatorHolders * 3) + Math.min(20, Math.floor(Number(formatEther(creatorVolume)))));
  const creatorBadges = [
    created.length > 0 && ["ORIGIN", "Launched a canonical market"],
    creatorVolume > 0n && ["ON THE TAPE", "Generated confirmed trading volume"],
    creatorHolders >= 3 && ["COMMUNITY", "Reached 3 indexed holders"],
    graduatedCount > 0 && ["GRADUATED", "Moved a market to ARC DEX"],
    arenaRank === 1 && ["ARENA LEADER", "Currently leads the weekly round"],
  ].filter(Boolean) as string[][];
  const orbitMissions = [
    { key: "position", label: "Take a position", note: "Hold any canonical Arcodian coin", done: holdings.length > 0 },
    { key: "creator", label: "Open a market", note: "Create one coin through the canonical factory", done: created.length > 0 },
    { key: "community", label: "Find the community", note: "Reach three indexed holders on a created coin", done: creatorHolders >= 3 },
    { key: "referral", label: "Bring three readers", note: "Reach three unique daily referral visitors", done: referralStats.uniqueVisitors >= 3 },
    { key: "arena", label: "Lead the orbit", note: "Reach #1 in the active Coin Arena round", done: arenaRank === 1 },
    { key: "graduation", label: "Finish the curve", note: "Graduate a market into ARC DEX", done: graduatedCount > 0 },
  ];
  const completedMissions = orbitMissions.filter((mission) => mission.done).length;
  const creatorVolume24h = created.reduce((sum,item)=>sum+BigInt(item.volume24h||"0"),0n);
  const graduationRate = created.length ? (graduatedCount / created.length) * 100 : 0;
  const bestMarket = [...created].sort((a,b)=>BigInt(b.volume||"0")>BigInt(a.volume||"0")?1:-1)[0];
  return (
    <section className="market-board profile-page">
      <div className="profile-head">
        <div>
          <p className="kicker">Onchain profile</p>
          <h2>{account ? short(account) : "Connect your wallet"}</h2>
          <p>
            Holdings and position values are read directly from canonical ARC
            markets.
          </p>
        </div>
        <button className="primary" onClick={connect}>
          {account ? "Change wallet" : "Connect wallet"}
        </button>
      </div>
      {account && (
        <>
          <div className="profile-stats">
            <span>
              <small>Portfolio value</small>
              <b>
                {Number(formatEther(total)).toLocaleString(undefined, {
                  maximumFractionDigits: 4,
                })}{" "}
                USDC
              </b>
            </span>
            <span>
              <small>Coins held</small>
              <b>{holdings.length}</b>
            </span>
            <span>
              <small>Network</small>
              <b>{activeArc.name}</b>
            </span>
            <span>
              <small>Coins created</small>
              <b>{created.length}</b>
            </span>
          </div>
          <div className="profile-tabs" role="tablist">
            <button className={profileTab === "holdings" ? "active" : ""} onClick={() => setProfileTab("holdings")}><b>Holdings</b><small>{holdings.length} positions</small></button>
            <button className={profileTab === "created" ? "active" : ""} onClick={() => setProfileTab("created")}><b>Created</b><small>{created.length} markets</small></button>
            <button className={profileTab === "activity" ? "active" : ""} onClick={() => setProfileTab("activity")}><b>Activity</b><small>{activities.length} transactions</small></button>
            <button className={profileTab === "reputation" ? "active" : ""} onClick={() => setProfileTab("reputation")}><b>Reputation</b><small>{reputationScore}/100 score</small></button>
          </div>
          {profileTab === "activity" && (
            <section className="activity-center">
              <div className="section-title"><strong>Coin Activity</strong><small>Canonical onchain Buy/Sell history · refreshes every 5 seconds</small></div>
              <div className="activity-list">
                {activities.slice(0, activityVisible).map((item) => <article key={`${item.id}-${item.kind}`}>
                  <span className={`activity-kind ${item.kind.toLowerCase()}`}>{item.kind}</span>
                  <span><b>{item.title}</b><small>{item.detail}</small><time>{new Date(item.updatedAt).toLocaleString()}</time></span>
                  <em className={`activity-status ${item.status}`}>{item.status}</em>
                  {item.txHash ? <a href={`${activeArc.explorer}/tx/${item.txHash}`} target="_blank" rel="noreferrer">Explorer ↗</a> : <small>Awaiting transaction hash</small>}
                </article>)}
                {!activities.length && <div className="loading-board">No Buy or Sell activity recorded for Arcodian-created coins yet.</div>}
              </div>
              {activityVisible < activities.length && <button className="secondary" onClick={() => setActivityVisible((value) => value + 20)}>Load 20 more</button>}
              <p className="fine">History is read from the shared onchain index and survives browser/device changes. Pending local trades are merged until indexed. Bridge, Swap, transfers, and non-canonical markets are excluded.</p>
            </section>
          )}
          {profileTab === "reputation" && <section className="orbit-missions">
            <div className="mission-intro"><p className="kicker">Orbit missions</p><h3>Progress that leaves a trace.</h3><span>Every completed step comes from public market data or privacy-safe referral attribution. No points, token, or airdrop is promised.</span><div><i style={{width:`${(completedMissions / orbitMissions.length) * 100}%`}} /></div><small>{completedMissions} of {orbitMissions.length} complete</small></div>
            <div className="mission-list">{orbitMissions.map((mission,index) => <article className={mission.done ? "complete" : ""} key={mission.key}><b>{mission.done ? "✓" : String(index + 1).padStart(2,"0")}</b><span><strong>{mission.label}</strong><small>{mission.note}</small></span><em>{mission.done ? "Complete" : "Open"}</em></article>)}</div>
          </section>}
          {profileTab === "reputation" && created.length > 0 && <section className="creator-reputation">
            <div className="reputation-score"><span><small>Creator reputation</small><b>{reputationScore}<i>/100</i></b></span><div><i style={{width:`${reputationScore}%`}} /></div><p>Computed from canonical launches, holders, volume, graduation, and Arena standing.</p></div>
            <div className="reputation-facts"><span><small>Creator volume</small><b>{Number(formatEther(creatorVolume)).toLocaleString(undefined,{maximumFractionDigits:2})} USDC</b></span><span><small>Indexed holders</small><b>{creatorHolders}</b></span><span><small>Best Arena rank</small><b>{arenaRank ? `#${arenaRank}` : "—"}</b></span></div>
            <div className="creator-badges">{creatorBadges.map(([badge,description]) => <span key={badge}><b>{badge}</b><small>{description}</small></span>)}</div>
          </section>}
          {profileTab === "created" && created.length > 0 && <section className="creator-passport">
            <div className="passport-head"><div><p className="kicker">Creator passport</p><h3>A public launch record—not a paid verification.</h3><span>Identity here means control of this wallet plus canonical market history. Arcodian does not endorse token quality or future performance.</span></div><button onClick={() => void navigator.clipboard.writeText(`${window.location.origin}/profile/${account}`)}>Copy creator profile ↗</button></div>
            <div className="passport-metrics"><span><small>Canonical launches</small><b>{created.length}</b></span><span><small>Graduation rate</small><b>{graduationRate.toFixed(0)}%</b></span><span><small>24h creator volume</small><b>{Number(formatEther(creatorVolume24h)).toLocaleString(undefined,{maximumFractionDigits:2})} USDC</b></span><span><small>Best market by volume</small><b>{bestMarket ? `$${bestMarket.symbol}` : "—"}</b></span></div>
            <div className="passport-proof"><span><i>01</i><b>Wallet ownership</b><small>Profile address is the public creator identity.</small></span><span><i>02</i><b>Factory provenance</b><small>Every listed launch comes from a canonical factory.</small></span><span><i>03</i><b>Market history</b><small>Volume, holders, ranking, and graduation are indexed from public activity.</small></span></div>
          </section>}
          {profileTab === "reputation" && <section className="referral-insights">
            <div><p className="kicker">Referral insights</p><h3>Share reach, without reward theatre.</h3><span>Visits are attributed for product analytics only. No token, fee share, or airdrop is promised.</span></div>
            <div className="referral-numbers"><span><small>Attributed visits</small><b>{referralStats.visits}</b></span><span><small>Unique daily visitors</small><b>{referralStats.uniqueVisitors}</b></span><button onClick={() => void navigator.clipboard.writeText(`${window.location.origin}/?ref=${account}`)}>Copy referral link ↗</button></div>
          </section>}
          {profileTab === "holdings" && (loading ? (
            <div className="loading-board">
              Reading wallet positions onchain…
            </div>
          ) : holdings.length ? (
            <div className="holdings-list">
              {holdings.map((item) => (
                <button
                  key={item.address}
                  onClick={() => chooseCoin(item.address)}
                >
                  <span className="asset">
                    {item.image ? (
                      <img src={imageUrl(item.image)} alt="" />
                    ) : (
                      <b>{item.symbol[0]}</b>
                    )}
                    <span>
                      <strong>{item.symbol}</strong>
                      <small>{item.name}</small>
                    </span>
                  </span>
                  <span>
                    <small>Balance</small>
                    <b>
                      {Number(formatEther(item.balance)).toLocaleString(
                        undefined,
                        { maximumFractionDigits: 4 },
                      )}
                    </b>
                  </span>
                  <span>
                    <small>Est. value</small>
                    <b>
                      {Number(formatEther(item.value)).toLocaleString(
                        undefined,
                        { maximumFractionDigits: 4 },
                      )}{" "}
                      USDC
                    </b>
                  </span>
                  <i>Open →</i>
                </button>
              ))}
            </div>
          ) : (
            <div className="loading-board">
              No launch coin holdings found in this wallet.
            </div>
          ))}
          {profileTab === "created" && !loading && created.length > 0 && (
            <div className="created-markets">
              <p className="kicker">Created markets</p>
              <div className="holdings-list">
                {created.map((item) => (
                  <button key={`created-${item.address}`} onClick={() => chooseCoin(item.address)}>
                    <span className="asset">{item.image ? <img src={imageUrl(item.image)} alt="" /> : <b>{item.symbol[0]}</b>}<span><strong>{item.symbol}</strong><small>{item.name}</small></span></span>
                    <span><small>{item.graduated ? "Venue" : "Progress"}</small><b>{item.graduated ? "ARC DEX" : `${item.progress.toFixed(2)}%`}</b></span><span><small>24h volume</small><b>{Number(formatEther(BigInt(item.volume24h||"0"))).toLocaleString(undefined,{maximumFractionDigits:2})} USDC</b></span><i>→</i>
                  </button>
                ))}
              </div>
            </div>
          )}
          {profileTab === "created" && !created.length && <div className="loading-board">No canonical markets created by this wallet yet.</div>}
        </>
      )}
    </section>
  );
}

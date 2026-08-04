import { useEffect, useRef, useState } from "react";
import { BrowserProvider, Contract, JsonRpcProvider, Network, formatEther, formatUnits, parseEther, verifyMessage } from "ethers";
import { ARC, ARC_EURC_ADDRESS, ARC_MAINNET, ARC_MAINNET_CONTRACTS, ARC_USDC_ERC20, CROSS_BUY_ROUTER_ADDRESS, ENGINE_VERSION, EURC_PUMP_FACTORY_ADDRESS, LEGACY_PUMP_FACTORY_ADDRESSES, PUMP_FACTORY_ADDRESS, TOKENS } from "../config";
import { ARC_PUMP_FACTORY_ABI } from "../generated/arcPumpFactory";
import { CurrencyToggle, loadDisplayCurrency } from "../components/CurrencyToggle";
import { CostLine } from "../components/CostLine";
import { TerminalChart, type Candle } from "../components/TerminalChart";
import { convert, currencyOf, routeFor, trueCost, type Currency, type FxRate } from "../fx";
import { fetchFxRate } from "../fxRate";
import { isFreshMarketIndex } from "../marketData";
import { describeTxError } from "../txError";
import {
  arcProvider,
  communitySigningMessage,
  ensureWalletChain,
  imageUrl,
  normalizeSocial,
  patchActivity,
  rpcUrlsFor,
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

// Stable reference for the mainnet branch below — `isMainnet ? [] : ...`
// inline would allocate a new array every render, and since the launch-fetch
// effect depends on activeLegacyFactories by reference, that turned into an
// infinite refetch loop for the entire time the app was defaulting to
// mainnet with no legacy factories (found 2026-07-31: mainnet Market never
// finished loading, stuck on "Reading canonical factories onchain…").
// Only compacts once a value is large enough that "1.2K" is actually more
// legible than the exact figure — a freshly-launched coin's numbers are
// still small enough that compacting them ("1K" for 1,003.96) throws away
// the precision without buying any real readability.
// Percentage-change display: null/undefined means "no baseline old enough
// to compute this window" (e.g. a token's first trade was 2 minutes ago —
// there's no real "5m ago" price), which is genuinely different from an
// actual 0.00% move. Coercing it to 0 (the old `value || 0` pattern) made
// every quiet market look permanently frozen at "+0.00%" no matter how
// much real buying/selling had happened. Render "—" for the unknown case.
function pctText(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}
function pctClass(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  return value >= 0 ? "positive" : "negative";
}

function compactNumber(value: number): string {
  if (!isFinite(value)) return "0";
  if (Math.abs(value) < 10_000) return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return value.toLocaleString(undefined, { maximumFractionDigits: 2, notation: "compact" });
}

// Global Radar/V2/V3/V4 records store USDC aggregates in raw 6-decimal
// units. Canonical launch records use the contract's 18-decimal accounting.
// Keep the conversion at the presentation boundary so ranking and onchain
// values remain untouched.
function globalUsdc(value: string | number | bigint | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  return Number(value) / 1e6;
}

function displayMarketCap(item: LaunchAsset): number {
  return item.globalPool ? globalUsdc(item.marketCap) : Number(formatEther(BigInt(item.marketCap || "0")));
}

function displayLiquidity(item: LaunchAsset): number {
  return item.globalPool
    ? globalUsdc(item.liquidity || item.reserve)
    : Number(formatEther(BigInt(item.liquidity || item.reserve.toString())));
}

function displayVolume24h(item: LaunchAsset): number {
  return item.globalPool
    ? globalUsdc(item.volume24h || "0")
    : Number(formatEther(BigInt(item.volume24h || item.volume || "0")));
}
// V8 (marketUsdcFactory, ARCD) is retired — no longer read at all, mainnet
// Market only ever lists V9 launches now. The original V9 factory
// (0x071f978A...327066) was retired 2026-08-02 for a treasury-address bug
// (fee went to the deployer EOA, not the treasury multisig) — its one live
// launch ("Architects") stays readable here as a legacy factory since it
// can't migrate to the corrected one.
const MAINNET_LEGACY_FACTORIES: string[] = [
  "0x071f978A9e7b8Ea0Ad914cba0d4C2c097f327066",
  "0x6e1d1a09b07a4022B535269434C16A3452e195f9",
];

export default function Screener({
  account,
  chainId,
  activeProvider,
  connect,
  coinAddress,
  chooseCoin,
  closeCoin,
}: {
  account: string;
  chainId?: number | null;
  activeProvider: EthereumProvider | null;
  connect: () => void;
  coinAddress: string;
  chooseCoin: (address: string) => void;
  closeCoin: () => void;
}) {
  // Arc Mainnet's USDC-only launch/DEX stack went live 2026-07-30
  // (ARC_MAINNET_CONTRACTS.marketUsdcFactory) — auto-detected from the
  // connected wallet's chain, same pattern as the bridge's arcNetworkMode.
  // EURC and cross-buy have no mainnet contract yet, so they stay
  // testnet-only until those are deployed separately.
  // Default to mainnet when no wallet is connected yet (chainId is null on
  // first load): Market carries real value and is the page's whole point —
  // showing the empty testnet index to every disconnected visitor hid every
  // real mainnet launch (including the first one, ARCD) behind "connect a
  // wallet on the right chain first". Only fall back to testnet once a
  // connected wallet explicitly reports it.
  // Market is a Mainnet-only product now. Keep the data source stable even
  // while a wallet is disconnected or still reporting an old testnet chain;
  // transaction handlers already switch the wallet to Arc Mainnet before
  // signing.
  const isMainnet = true;
  const activeArc = isMainnet ? ARC_MAINNET : ARC;
  // V9 (real Uniswap V3 graduation) is the primary and only mainnet factory
  // as of 2026-08-01 — every createLaunch() and every listing reads here. V8
  // (ArcPairFactoryV2 graduation, ARCD) is retired: no longer read anywhere,
  // so it no longer shows up in the Market screener.
  const activeFactory = isMainnet ? ARC_MAINNET_CONTRACTS.marketUsdcFactoryV10 : PUMP_FACTORY_ADDRESS;
  const activeLegacyFactories = isMainnet ? MAINNET_LEGACY_FACTORIES : LEGACY_PUMP_FACTORY_ADDRESSES;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("All");
  const [sortKey, setSortKey] = useState<"volume" | "change" | "holders" | "progress" | "marketCap" | "liquidity" | null>(null);
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [marketView, setMarketView] = useState<"markets" | "arena">("markets");
  // Display currency is presentation only — it never reaches a contract call.
  const [displayCurrency, setDisplayCurrency] = useState<Currency>(loadDisplayCurrency);
  const [fxRate, setFxRate] = useState<FxRate>({ eurcPerUsdc: 1, usdcPerEurc: 1 });
  const [launches, setLaunches] = useState<LaunchAsset[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(true);
  // If a coin isn't found on the wallet's current network, it might just be
  // on the OTHER one (mainnet vs testnet factories are entirely separate
  // deployments) — a wallet whose "Arc Mainnet" custom network entry has the
  // wrong chain ID, or one still sitting on testnet, made "Coin not found"
  // look like a broken link when the coin was right there on the other
  // network the whole time. Checked lazily, only once the primary lookup
  // above has already failed.
  const [wrongNetworkArc, setWrongNetworkArc] = useState<typeof ARC_MAINNET | typeof ARC | null>(null);
  const [arenaHistory, setArenaHistory] = useState<ArenaWinner[]>([]);
  const marketIndexStamp = useRef("");
  const [visibleLimit, setVisibleLimit] = useState(40);
  const [marketNotice, setMarketNotice] = useState<{ token: string; symbol: string; side: "BUY" | "SELL"; native: string } | null>(null);
  const seenMarketTrades = useRef<Set<string>>(new Set());
  const marketTradeFeedReady = useRef(false);
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
    let stopped = false;
    let busy = false;
    const poll = async () => {
      if (stopped || busy || document.visibilityState === "hidden") return;
      busy = true;
      try {
        const response = await fetch("/data/mainnet-live-tape.json", { cache: "no-store" });
        if (!response.ok) throw new Error("TAPE_UNAVAILABLE");
        const tape = await response.json() as { trades?: Array<{ token: string; symbol?: string; side: "BUY" | "SELL"; tx: string; native: string; timestamp?: number }> };
        const trades = (tape.trades || []).slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        if (!marketTradeFeedReady.current) {
          trades.forEach((trade) => seenMarketTrades.current.add(`${trade.tx}:${trade.side}`));
          marketTradeFeedReady.current = true;
        } else {
          const fresh = trades.filter((trade) => !seenMarketTrades.current.has(`${trade.tx}:${trade.side}`));
          trades.forEach((trade) => seenMarketTrades.current.add(`${trade.tx}:${trade.side}`));
          const latest = fresh.at(-1);
          if (latest) setMarketNotice({ token: latest.token, symbol: latest.symbol || "TOKEN", side: latest.side, native: latest.native });
        }
      } catch { /* Keep the last notice and retry on the next tick. */ }
      finally { busy = false; }
    };
    const timer = window.setInterval(() => { void poll(); }, 3_000);
    void poll();
    return () => { stopped = true; window.clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!marketNotice) return;
    const timer = window.setTimeout(() => setMarketNotice(null), 6_000);
    return () => window.clearTimeout(timer);
  }, [marketNotice]);
  useEffect(() => {
    let cancelled = false;
    const provider = arcProvider(activeArc);
    fetchFxRate(provider)
      .then((rate) => { if (!cancelled) setFxRate(rate); })
      .catch(() => { /* parity fallback already in state */ });
    return () => { cancelled = true; provider.destroy(); };
  }, [activeArc]);
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
    // Re-fires whenever isMainnet flips (e.g. the wallet finishes connecting
    // a beat after mount, testnet -> mainnet). Without resetting loading
    // here, the *first* run's setLoading(false) sticks, so a coin page for
    // a mainnet-only address briefly (or not-so-briefly, on a slow RPC)
    // renders "Coin not found" instead of "Loading" while the real mainnet
    // fetch is still in flight — easy to mistake for a broken Buy button.
    setLoading(true);
    const provider = arcProvider(activeArc);
    (async () => {
      // Both networks now have a server-side indexer producing a static JSON
      // snapshot (market-index.json for testnet, mainnet-market-index.json
      // for mainnet — added 2026-07-31 after every open browser tab scanning
      // full Bought/Sold history itself drew sustained HTTP 429s from the
      // shared free-tier Arc Mainnet RPC, showing up as holders/trades/the
      // live tape flickering "temporarily offline"). Only fall through to a
      // live RPC scan if the snapshot is missing or stale.
      try {
        const response = await fetch(isMainnet ? "/data/mainnet-market-index.json" : "/data/market-index.json", { cache: "no-store" });
        if (response.ok) {
          const index = await response.json() as { indexedAt: string; arena?: { history?: ArenaWinner[] }; launches: Array<Omit<LaunchAsset, "reserve" | "virtualReserve" | "threshold" | "inventory" | "progress" | "type" | "risk"> & { reserve: string; virtualReserve: string; threshold: string; inventory: string }> };
          if (Array.isArray(index.launches) && isFreshMarketIndex(index.indexedAt)) {
            marketIndexStamp.current = index.indexedAt;
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
  }, [isMainnet, activeArc, activeFactory, activeLegacyFactories]);
  useEffect(() => {
    let stopped = false;
    let busy = false;
    // Same testnet-only indexer caveat as above — nothing to poll for mainnet yet.
    const pollMarket = async () => {
      if (stopped || busy || document.visibilityState === "hidden") return;
      busy = true;
      try {
        const response = await fetch(isMainnet ? "/data/mainnet-market-index.json" : "/data/market-index.json", { cache: "no-cache" });
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
    return () => { stopped = true; window.clearInterval(timer); window.removeEventListener("focus", pollMarket); document.removeEventListener("visibilitychange", onVisibility); };
  }, [isMainnet]);
  const selected = coinAddress
    ? launches.find(
        (asset) => asset.address.toLowerCase() === coinAddress.toLowerCase(),
      ) || null
    : null;
  useEffect(() => {
    setWrongNetworkArc(null);
    if (loading || !coinAddress || selected) return;
    const otherArc = isMainnet ? ARC : ARC_MAINNET;
    const otherFactory = isMainnet ? PUMP_FACTORY_ADDRESS : ARC_MAINNET_CONTRACTS.marketUsdcFactoryV10;
    let alive = true;
    const provider = arcProvider(otherArc);
    (async () => {
      const factory = new Contract(otherFactory, ARC_PUMP_FACTORY_ABI, provider);
      const count = Number(await factory.launchCount());
      for (let id = count; id >= 1; id--) {
        const tokenAddress = (await factory.tokenByLaunch(id)) as string;
        if (tokenAddress.toLowerCase() === coinAddress.toLowerCase()) {
          if (alive) setWrongNetworkArc(otherArc);
          return;
        }
      }
    })().catch(() => { /* best-effort — stay on the plain "not found" message */ })
      .finally(() => provider.destroy());
    return () => { alive = false; };
  }, [loading, coinAddress, selected, isMainnet]);
  async function switchToArc(target: typeof ARC_MAINNET | typeof ARC) {
    if (!activeProvider) { connect(); return; }
    try {
      await activeProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: target.hexId }] });
    } catch {
      try {
        await activeProvider.request({
          method: "wallet_addEthereumChain",
          params: [{ chainId: target.hexId, chainName: target.name, nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: rpcUrlsFor(target), blockExplorerUrls: [target.explorer] }],
        });
      } catch { /* user declined or wallet doesn't support programmatic network add */ }
    }
  }
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
    // Radar/global Uniswap pools are discoverable in the market catalog, but
    // they were not created by our factory and must never look like launches.
    const isCanonicalLaunch = !item.globalPool;
    if (filter === "New" || filter === "Launchpad") return isCanonicalLaunch && !item.graduated;
    if (filter === "Global") return Boolean(item.globalPool || item.graduated);
    if (filter === "Trending") return true;
    if (filter === "Gainers") return (item.priceChange24h || 0) > 0;
    if (filter === "Graduating") return !item.graduated && item.progress >= 50;
    if (filter === "Graduated") return item.graduated;
    if (filter === "Arcodian DEX") return item.dex === "Arcodian DEX";
    if (filter === "Uniswap V3") return item.dex === "Uniswap V3";
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
  function sortBy(key: "volume" | "change" | "holders" | "progress" | "marketCap" | "liquidity") {
    if (sortKey === key) setSortDir((dir) => (dir === 1 ? -1 : 1));
    else { setSortKey(key); setSortDir(-1); }
  }
  function rowMetric(item: (typeof rows)[number], key: "volume" | "change" | "holders" | "progress" | "marketCap" | "liquidity") {
    if (!("curve" in item)) return -1;
    if (key === "volume") return displayVolume24h(item);
    if (key === "change") return item.priceChange24h || 0;
    if (key === "holders") return item.holderCount || 0;
    if (key === "marketCap") return displayMarketCap(item);
    if (key === "liquidity") return displayLiquidity(item);
    return item.progress;
  }
  const tableRows = sortKey ? [...rows].sort((a, b) => (rowMetric(b, sortKey) - rowMetric(a, sortKey)) * (sortDir === -1 ? 1 : -1)) : rows;
  const visibleRows = tableRows.slice(0, visibleLimit);
  useEffect(() => {
    setVisibleLimit(40);
  }, [filter, query, sortKey, sortDir]);
  const sortMark = (key: string) => (sortKey === key ? (sortDir === -1 ? " ↓" : " ↑") : "");
  function openMarketAsset(item: LaunchAsset) {
    if (item.globalPool) {
      window.location.href = `/terminal?token=${encodeURIComponent(item.address)}&input=USDC`;
      return;
    }
    chooseCoin(item.address);
  }
  function isGlobalPool(item: (typeof rows)[number]): item is LaunchAsset & { globalPool: true } {
    return "globalPool" in item && item.globalPool === true;
  }
  const arenaContenders = launches
    .filter((item) => !item.graduated)
    .map((item) => ({
      ...item,
      arenaScore: displayVolume24h(item) * 100
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
  const totalVolume = launches.reduce((sum, item) => sum + displayVolume24h(item), 0);
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
            {wrongNetworkArc ? (
              <>
                <h2>Wrong network</h2>
                <p>This coin is on <strong>{wrongNetworkArc.name}</strong>, but your wallet is on {activeArc.name}. Switch networks to view and trade it.</p>
                <button className="primary" onClick={() => void switchToArc(wrongNetworkArc)}>
                  Switch to {wrongNetworkArc.name}
                </button>
              </>
            ) : (
              <>
                <h2>Coin not found</h2>
                <p>This contract is not registered by a canonical ARC factory.</p>
              </>
            )}
            <button className={wrongNetworkArc ? "" : "primary"} onClick={closeCoin}>
              Back to market
            </button>
          </div>
        </section>
      );
    return (
      <TradingDesk
        asset={selected}
        account={account}
        isMainnet={isMainnet}
        activeArc={activeArc}
        activeProvider={activeProvider}
        connect={connect}
        close={closeCoin}
        fxRate={fxRate}
      />
    );
  }
  return (
    <section className="market-board market-terminal" id="market">
      {marketNotice && (
        <div className={`market-trade-notice ${marketNotice.side === "BUY" ? "buy" : "sell"}`} role="status" aria-live="polite">
          <span className="market-trade-notice-dot" />
          <span className="market-trade-notice-copy"><b>${marketNotice.symbol}</b><strong>{Number(formatUnits(BigInt(marketNotice.native || "0"), 6)).toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC · {marketNotice.side}</strong><small>Live onchain trade</small></span>
          <button type="button" onClick={() => chooseCoin(marketNotice.token)}>Open ↗</button>
        </div>
      )}
      <div className="terminal-stats">
        <span>
          <b>LIVE</b> {isMainnet ? "Arc Mainnet" : "Arc Testnet"}
        </span>
        <span>{launches.length} canonical markets</span>
        <span>{totalTrades} confirmed trades</span>
        <span>{compactNumber(totalVolume)} USDC volume</span>
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
        <span><small>FACTORIES</small><b>{isMainnet ? "USDC canonical" : "USDC + EURC canonical"}</b></span>
        <span><small>GRADUATION</small><b>12,000 stablecoin reserve</b></span>
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
                <div className="arena-score"><strong>{share}%</strong><span>{compactNumber(displayVolume24h(item))} USDC · {item.tradeCount || 0} trades</span></div>
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
        {["All", "Launchpad", "New", "Global", "Trending", "Gainers", "Graduating", "Graduated", "Arcodian DEX", "Uniswap V3", "Watchlist"].map((item) => (
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
      <div className="screener-sort-bar" aria-label="Global market sorting">
        <span>Sort global markets:</span>
        {([["marketCap", "Market cap"], ["liquidity", "Liquidity"], ["volume", "24h volume"]] as const).map(([key, label]) => (
          <button key={key} className={sortKey === key ? "active" : ""} onClick={() => sortBy(key)}>{label}{sortMark(key)}</button>
        ))}
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
            <button onClick={() => sortBy("marketCap")} className={sortKey === "marketCap" ? "active" : ""}>Market cap{sortMark("marketCap")}</button>
            <button onClick={() => sortBy("volume")} className={sortKey === "volume" ? "active" : ""}>24h Vol{sortMark("volume")}</button>
            <button onClick={() => sortBy("change")} className={sortKey === "change" ? "active" : ""}>24h %{sortMark("change")}</button>
            <button onClick={() => sortBy("holders")} className={sortKey === "holders" ? "active" : ""}>Holders{sortMark("holders")}</button>
            <button onClick={() => sortBy("progress")} className={sortKey === "progress" ? "active" : ""}>Bonding{sortMark("progress")}</button>
            <span>Status</span>
            <span aria-hidden="true" />
          </div>
          {visibleRows.map((item) => "curve" in item && !item.globalPool ? (
            <div className="mt-row" role="row" tabIndex={0} key={`t-${item.address}`}
              onClick={() => openMarketAsset(item)}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openMarketAsset(item); } }}>
              <span className="mt-market">
                {item.image ? <img src={imageUrl(item.image)} alt="" /> : <b>{item.symbol.slice(0, 1)}</b>}
                <span><strong>{item.symbol}</strong><small>{item.name}</small></span>
              </span>
              <span className="mt-num">{compactNumber(displayMarketCap(item))} <small>USDC</small></span>
              <span className="mt-num">{convert(
                Number(formatEther(BigInt(item.volume24h || item.volume || "0"))),
                currencyOf(item),
                displayCurrency,
                fxRate,
              ).toLocaleString(undefined, { maximumFractionDigits: 2 })} <small>{displayCurrency}</small></span>
              <span className={`mt-num ${pctClass(item.priceChange24h)}`}>{pctText(item.priceChange24h)}</span>
              <span className="mt-num">{item.holderCount || 0}</span>
              <span className="mt-progress"><i><em style={{ width: `${Math.min(100, item.progress)}%` }} /></i><b>{item.progress.toFixed(1)}%</b></span>
              <span className={`mt-status ${item.graduated ? "dex" : "curve"}`}>{item.graduated ? "Arcodian DEX" : item.risk}</span>
              <button className={watchlist.has(item.address.toLowerCase()) ? "mt-watch active" : "mt-watch"} aria-label={`Toggle ${item.symbol} watchlist`} onClick={(event) => { event.stopPropagation(); toggleWatch(item.address); }}>{watchlist.has(item.address.toLowerCase()) ? "★" : "☆"}</button>
            </div>
          ) : isGlobalPool(item) ? (
            <div className="mt-row mt-global-pool" role="row" tabIndex={0} key={`p-${item.pool || item.address}`}
              onClick={() => openMarketAsset(item)}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openMarketAsset(item); } }}>
              <span className="mt-market">{item.image ? <img src={imageUrl(item.image)} alt="" /> : <b>{item.symbol.slice(0, 1)}</b>}<span><strong>{item.symbol}</strong><small>{item.name} · {item.dex}</small></span></span>
              <span className="mt-num">{compactNumber(displayMarketCap(item))} <small>USDC</small></span>
              <span className="mt-num">{compactNumber(displayVolume24h(item))} <small>USDC</small></span>
              <span className={`mt-num ${pctClass(item.priceChange5m)}`}><small>5m </small>{pctText(item.priceChange5m)}</span>
              <span className={`mt-num ${pctClass(item.priceChange1h)}`}><small>1h </small>{pctText(item.priceChange1h)}</span>
              <span className="mt-num">{compactNumber(displayLiquidity(item))} <small>liq</small></span>
              <span className="mt-status dex" title={`${item.dex} · ${(Number(item.feeTier || 0) / 10000).toFixed(2)}%`}>{item.dex} · {(Number(item.feeTier || 0) / 10000).toFixed(2)}%</span>
              <span className="mt-watch">↗</span>
            </div>
          ) : (
            <div className="mt-row mt-official" role="row" key={`t-${item.address}`}>
              <span className="mt-market"><b>{item.symbol.slice(0, 1)}</b><span><strong>{item.symbol}</strong><small>{item.name}</small></span></span>
              <span className="mt-num">—</span><span className="mt-num">—</span><span className="mt-num">—</span><span className="mt-num">—</span>
              <span className="mt-progress"><small>Circle official asset</small></span>
              <span className="mt-status official">Official</span>
              <a href={`${activeArc.explorer}/address/${item.address}`} target="_blank" rel="noreferrer" aria-label={`View ${item.symbol} contract`}>↗</a>
            </div>
          ))}
          {!tableRows.length && <div className="loading-board">No market matches this filter.</div>}
        </div>
        <div className="coin-grid market-cards-view">
          {visibleRows.map((item) => (
            <article
              className={`coin-card ${"curve" in item ? "tradeable" : ""}`}
              key={item.address}
              onClick={() => {
                if ("curve" in item) openMarketAsset(item);
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
                  {"curve" in item && !item.globalPool && (
                    <button className={watchlist.has(item.address.toLowerCase()) ? "watch active" : "watch"} aria-label="Toggle watchlist" onClick={(event) => { event.stopPropagation(); toggleWatch(item.address); }}>
                      {watchlist.has(item.address.toLowerCase()) ? "★" : "☆"}
                    </button>
                  )}
                  <span className="verified">● {item.risk}</span>
                </span>
              </div>
              {isGlobalPool(item) ? (
                <>
                  <div className="global-pool-metrics">
                    <span><small>5m</small><b className={pctClass(item.priceChange5m)}>{pctText(item.priceChange5m)}</b></span>
                    <span><small>10m</small><b className={pctClass(item.priceChange10m)}>{pctText(item.priceChange10m)}</b></span>
                    <span><small>1h</small><b className={pctClass(item.priceChange1h)}>{pctText(item.priceChange1h)}</b></span>
                    <span><small>24h</small><b className={pctClass(item.priceChange24h)}>{pctText(item.priceChange24h)}</b></span>
                  </div>
                  <div className="global-pool-submetrics"><span>Market cap <b>{compactNumber(displayMarketCap(item))} USDC</b></span><span>Liquidity <b>{compactNumber(displayLiquidity(item))} USDC</b></span><span>24h volume <b>{compactNumber(displayVolume24h(item))} USDC</b></span></div>
                  <button type="button" onClick={(event) => { event.stopPropagation(); openMarketAsset(item); }}>Open in Terminal →</button>
                </>
              ) : "progress" in item ? (
                <>
                  <div className="coin-discovery-metrics">
                    <span><small>All-time volume</small><b>{Number(formatEther(BigInt(item.volume || "0"))).toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC</b></span>
                    <span><small>Holders</small><b>{item.holderCount || 0}</b></span>
                    <span><small>24h</small><b className={pctClass(item.priceChange24h)}>{pctText(item.priceChange24h)}</b></span>
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
                    href={`${activeArc.explorer}/address/${item.address}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View contract ↗
                  </a>
                </>
              )}
          </article>
          ))}
          {rows.length > visibleLimit && (
            <button className="market-load-more" type="button" onClick={() => setVisibleLimit((limit) => Math.min(limit + 40, rows.length))}>
              Show more markets ({rows.length - visibleLimit} remaining)
            </button>
          )}
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
              isMainnet={isMainnet}
              activeArc={activeArc}
              activeFactory={activeFactory}
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
  isMainnet,
  activeArc,
  activeProvider,
  connect,
  close,
  fxRate,
}: {
  asset: LaunchAsset;
  account: string;
  isMainnet: boolean;
  activeArc: typeof ARC | typeof ARC_MAINNET;
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
  // false for a V8-graduated ArcPair (v2-style, in-house AMM), true for a
  // V9-graduated real Uniswap V3 pool — the two need entirely different
  // quote/execution paths (ArcPair.swap() vs SwapRouter.exactInputSingle()).
  const [pairIsV3, setPairIsV3] = useState(false);
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
  const [timeframe, setTimeframe] = useState<1 | 15 | 60 | 300 | 900 | 3600>(60);
  const [chartWindow, setChartWindow] = useState(30);
  const [chartHover, setChartHover] = useState<Candle | null>(null);
  const [netCost, setNetCost] = useState(0n);
  const [liveTrades, setLiveTrades] = useState<
    Array<{ side: "BUY" | "SELL"; amount: bigint; tokens: bigint }>
  >(() => (asset.trades || []).slice(-12).reverse().map((event) => ({
    side: event.side,
    amount: BigInt(event.native),
    tokens: BigInt(event.tokens),
  })));
  const [chartTrades, setChartTrades] = useState<NonNullable<LaunchAsset["trades"]>>(asset.trades || []);
  // Canonical launch curves use Arc native USDC (18 decimals) on both
  // networks. Only Radar/global ERC-20 pool records use 6-decimal USDC.
  const quoteDecimals = asset.globalPool ? 6 : 18;
  const formatTradeQuote = (value: bigint) => Number(formatUnits(value, quoteDecimals));
  const formatTradeToken = (value: bigint) => Number(formatEther(value));
  const tradePrice = (native: bigint, tokens: bigint) => {
    const tokenAmount = formatTradeToken(tokens);
    return tokenAmount > 0 ? formatTradeQuote(native) / tokenAmount : 0;
  };
  const [tapeHealth, setTapeHealth] = useState<"live" | "delayed" | "offline">("delayed");
  const [copied, setCopied] = useState(false);
  // Best-effort verification check (mainnet only — no confirmed-working
  // testnet explorer API pattern). Routed through a same-origin proxy
  // (verify-status.php) — arc.exploreme.pro sends no Access-Control-Allow-
  // Origin header at all, so a direct browser fetch is CORS-blocked even
  // though the exact same call works fine server-side (found 2026-07-31,
  // same story as rpc-mainnet.php existing for the same reason). Never
  // blocks rendering: any failure just leaves this "unknown".
  const [verified, setVerified] = useState<boolean | null>(null);
  useEffect(() => {
    setVerified(null);
    if (!isMainnet) return;
    let alive = true;
    fetch(`/api/verify-status.php?address=${asset.address}`)
      .then((response) => response.ok ? response.json() : null)
      .then((data: { verified?: boolean | null } | null) => { if (alive) setVerified(data?.verified ?? null); })
      .catch(() => { if (alive) setVerified(null); });
    return () => { alive = false; };
  }, [asset.address, isMainnet]);
  const optimisticTapeUntil = useRef(0);
  useEffect(() => {
    const seeded = (asset.trades || []).slice(-12).reverse().map((event) => ({
      side: event.side,
      amount: BigInt(event.native),
      tokens: BigInt(event.tokens),
    }));
    setChartTrades(asset.trades || []);
    setLiveTrades(seeded);
  }, [asset.address, asset.trades]);
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
    const curveState = new Contract(asset.curve, ["function graduated() view returns(bool)"], provider);
    const nextGraduated = await curveState.graduated() as boolean;
    // V8 curves expose pair() (ArcPair, our own v2-style AMM). V9 curves
    // expose pool() (a real Uniswap V3 pool) instead — neither function
    // exists on the other curve version, so calling the wrong one reverts.
    // Probing both, tolerating either failing, keeps this working across
    // every curve generation without the caller needing to know which one
    // asset.curve actually is (found 2026-07-31: the old hardcoded pair()-only
    // call reverted every second for every V9 market, including ARDN).
    let nextVenue = asset.curve;
    let nextVenueIsV3Pool = false;
    if (nextGraduated) {
      try {
        const pairProbe = new Contract(asset.curve, ["function pair() view returns(address)"], provider);
        const candidate = await pairProbe.pair() as string;
        if (candidate !== "0x0000000000000000000000000000000000000000") nextVenue = candidate;
      } catch {
        try {
          const poolProbe = new Contract(asset.curve, ["function pool() view returns(address)"], provider);
          const candidate = await poolProbe.pool() as string;
          if (candidate !== "0x0000000000000000000000000000000000000000") { nextVenue = candidate; nextVenueIsV3Pool = true; }
        } catch { /* Neither venue accessor exists yet — fall back to the curve itself. */ }
      }
    }
    const nextPair = nextVenue !== asset.curve ? nextVenue : "";
    const token = new Contract(asset.address, ["function balanceOf(address) view returns(uint256)"], provider);
    let nextReserve: bigint;
    let nextInventory: bigint;
    if (nextGraduated && nextVenueIsV3Pool) {
      // Concentrated liquidity has no simple reserve0/reserve1 — the pool's
      // own token balances stand in as a display-only reserve proxy, same
      // approach the mainnet indexer uses.
      const usdcAddress = isEurc ? ARC_EURC_ADDRESS : ARC_USDC_ERC20;
      const usdcReader = new Contract(usdcAddress, ["function balanceOf(address) view returns(uint256)"], provider);
      [nextInventory, nextReserve] = await Promise.all([
        token.balanceOf(nextVenue) as Promise<bigint>, usdcReader.balanceOf(nextVenue) as Promise<bigint>,
      ]);
      if (isEurc) nextReserve *= pairScale;
    } else if (nextGraduated) {
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
    setPair(nextPair);
    setPairIsV3(nextVenueIsV3Pool);
    setReserve(nextReserve);
    setInventory(nextInventory);
  }

  useEffect(() => {
    const provider = arcProvider(activeArc);
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
    // "Your position" net-cost only — tapeHealth/liveTrades are owned
    // exclusively by the loadTape effect below now. This function used to
    // set them too, unconditionally against the TESTNET market-index.json
    // regardless of which network the open coin was actually on — for any
    // mainnet coin that lookup always failed (wrong index entirely), which
    // silently forced tapeHealth to "offline" every 3s and raced with
    // loadTape's real, working mainnet read (found 2026-07-31: holders and
    // trade history displayed correctly, but the feed badge stayed stuck on
    // OFFLINE regardless — this was why).
    if (!account) { setNetCost(0n); return; }
    try {
      const response = await fetch(isMainnet ? "/data/mainnet-market-index.json" : "/data/market-index.json", { cache: "no-store" });
      if (!response.ok) throw new Error("INDEX_UNAVAILABLE");
      const index = await response.json() as {
        indexedAt?: string;
        launches?: Array<{
          address: string;
          trades?: Array<{ side: "BUY" | "SELL"; user: string; native: string; tokens: string }>;
        }>;
      };
      if (!isFreshMarketIndex(index.indexedAt)) throw new Error("INDEX_STALE");
      const market = index.launches?.find((item) => item.address.toLowerCase() === asset.address.toLowerCase());
      if (!market) throw new Error("MARKET_NOT_INDEXED");
      const mine = (market.trades || []).filter((event) => event.user.toLowerCase() === account.toLowerCase());
      const paid = mine.filter((event) => event.side === "BUY").reduce((sum, event) => sum + BigInt(event.native), 0n);
      const received = mine.filter((event) => event.side === "SELL").reduce((sum, event) => sum + BigInt(event.native), 0n);
      setNetCost(paid > received ? paid - received : 0n);
    } catch { /* Keep the last known position rather than blanking it on one bad poll. */ }
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
    // Both networks read a small static snapshot produced server-side
    // (mainnet-market-index.json / live-tape.json) instead of the browser
    // scanning Bought/Sold history itself. The mainnet branch used to do its
    // own incremental queryFilter every 3s per open tab — harmless with one
    // visitor, but it drew sustained HTTP 429s from the shared free-tier Arc
    // Mainnet RPC once there was real traffic, which is what "Indexed tape ·
    // temporarily offline" and unreadable holders were actually caused by
    // (found 2026-07-31). A single server-side indexer on a 30s timer now
    // does that scanning once for everyone.
    let loadingTape = false;
    let consecutiveFailures = 0;
    const loadTape = async () => {
      if (loadingTape || document.visibilityState === "hidden") return;
      loadingTape = true;
      try {
        if (isMainnet) {
          // mainnet-live-tape.mjs (1s cadence) tails only new Bought/Sold/Swap
          // logs — same idea as the testnet live-tape.json branch below. The
          // 30s mainnet-market-index.json snapshot below is still the seed
          // for full history (up to 200 trades per launch); this just keeps
          // the recent tail current instead of stalling for up to 30s.
          const response = await fetch("/data/mainnet-live-tape.json", { cache: "no-store" });
          if (!response.ok) throw new Error("TAPE_UNAVAILABLE");
          const tape = await response.json() as {
            indexedAt?: string;
            trades?: Array<{ token: string; symbol?: string; side: "BUY" | "SELL"; block: number; tx: string; user: string; native: string; tokens: string; timestamp: number }>;
          };
          const marketTrades = (tape.trades || []).filter((trade) => trade.token.toLowerCase() === asset.address.toLowerCase());
          consecutiveFailures = 0;
          setTapeHealth(tape.indexedAt && Date.now() - Date.parse(tape.indexedAt) <= 6_000 ? "live" : "delayed");
          setChartTrades(
            [...(asset.trades || []), ...marketTrades]
              .filter((trade, index, all) => all.findIndex((item) => item.tx === trade.tx && item.side === trade.side) === index)
              .sort((a, b) => a.block - b.block)
              .slice(-500),
          );
          if (marketTrades.length && Date.now() >= optimisticTapeUntil.current) {
            setLiveTrades(marketTrades.slice(-12).reverse().map((event) => ({ side: event.side, amount: BigInt(event.native), tokens: BigInt(event.tokens) })));
          }
        } else {
          const response = await fetch("/data/live-tape.json", { cache: "no-store" });
          if (!response.ok) throw new Error("TAPE_UNAVAILABLE");
          const tape = await response.json() as {
            indexedAt?: string;
            trades?: Array<{ token: string; side: "BUY" | "SELL"; block: number; tx: string; user: string; native: string; tokens: string; timestamp: number }>;
          };
          const marketTrades = (tape.trades || []).filter((trade) => trade.token.toLowerCase() === asset.address.toLowerCase());
          consecutiveFailures = 0;
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
        }
      } catch {
        // Same debounce as the mainnet scanner used to have: one missed
        // poll (a static file 404ing for a moment during a deploy, say)
        // shouldn't flip the badge to offline.
        consecutiveFailures += 1;
        if (consecutiveFailures >= 3) setTapeHealth("offline");
      }
      finally { loadingTape = false; }
    };
    void loadTape();
    const timer = window.setInterval(() => { void loadTape(); }, isMainnet ? 1_000 : 750);
    return () => window.clearInterval(timer);
  }, [asset.address, isMainnet]);

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
        params: [{ chainId: activeArc.hexId }],
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
      // A real Uniswap V3 pool has no view-only reserve0()/reserve1()/quote()
      // — quoting goes through the Quoter contract instead (staticCall; its
      // quoteExactInputSingle is non-view by design, computing the amount via
      // a revert-trick under the hood, same as every Uniswap V3 frontend).
      let v3QuoteOut = 0n;
      if (graduated && pairIsV3) {
        const quoter = new Contract(
          ARC_MAINNET_CONTRACTS.v3Quoter,
          ["function quoteExactInputSingle(address,address,uint24,uint256,uint160) returns(uint256)"],
          provider,
        );
        const tokenInAddr = side === "buy" ? ARC_USDC_ERC20 : asset.address;
        const tokenOutAddr = side === "buy" ? asset.address : ARC_USDC_ERC20;
        const amountInRaw = side === "buy" ? venueAmountWei / QSCALE : amountWei;
        v3QuoteOut = amountInRaw > 0n
          ? await quoter.quoteExactInputSingle.staticCall(tokenInAddr, tokenOutAddr, 3000, amountInRaw, 0) as bigint
          : 0n;
        freshInventory = 0n;
        freshReserve = 0n;
      } else if (graduated) {
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
      const freshRawQuote = graduated && pairIsV3
        ? (side === "buy" ? v3QuoteOut : v3QuoteOut * QSCALE)
        : graduated
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
      if (graduated && pairIsV3) {
        if (route === "manual") throw new Error("Switch to the pair quote currency before trading this graduated market.");
        const tokenInAddr = side === "buy" ? ARC_USDC_ERC20 : asset.address;
        const tokenOutAddr = side === "buy" ? asset.address : ARC_USDC_ERC20;
        const v3AmountIn = side === "buy" ? amountWei / QSCALE : amountWei;
        const v3AmountOutMinimum = side === "buy" ? minOut : minOut / QSCALE;
        const inputToken = new Contract(tokenInAddr, erc20Abi, signer);
        const allowance = await inputToken.allowance(owner, ARC_MAINNET_CONTRACTS.v3SwapRouter) as bigint;
        if (allowance < v3AmountIn) {
          setTradeStage("approval");
          setStatus(`Approve ${side === "buy" ? currency : asset.symbol} spending in your wallet.`);
          await (await inputToken.approve(ARC_MAINNET_CONTRACTS.v3SwapRouter, v3AmountIn)).wait();
        }
        const swapRouter = new Contract(
          ARC_MAINNET_CONTRACTS.v3SwapRouter,
          ["function exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160)) payable returns(uint256)"],
          signer,
        );
        tx = await swapRouter.exactInputSingle([
          tokenInAddr, tokenOutAddr, 3000, owner, deadline, v3AmountIn, v3AmountOutMinimum, 0,
        ]);
      } else if (graduated) {
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
      const rawMessage = String((error as { message?: unknown })?.message || "").toLowerCase();
      setStatus(rawMessage.includes("insufficient funds") ? `${currency} balance is too low to cover this trade and network fee.` : describeTxError(error));
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
  const tradePrices = chartTrades.slice(-500).map((trade) => ({ timestamp: trade.timestamp || trade.block, price: tradePrice(BigInt(trade.native), BigInt(trade.tokens)), volume: formatTradeQuote(BigInt(trade.native)) }));
  const candleMap = new Map<number, Array<{price:number;volume:number}>>();
  for (const point of tradePrices) { const bucket = Math.floor(point.timestamp / timeframe) * timeframe; candleMap.set(bucket, [...(candleMap.get(bucket) || []), {price:point.price,volume:point.volume}]); }
  const candles = [...candleMap.entries()].sort(([a], [b]) => a - b).slice(-chartWindow).map(([time, points]) => { const prices=points.map(point=>point.price); return { time, open: prices[0], close: prices[prices.length - 1], high: Math.max(...prices), low: Math.min(...prices), volume: points.reduce((sum,point)=>sum+point.volume,0) }; });
  const visibleCandles = candles;
  const lastPrice = tradePrices.at(-1)?.price || 0;
  // Price impact must compare execution against the current pool/curve spot
  // before the user's trade. Comparing against the previous trade made a
  // normal quote look like 18% impact after a large earlier buy.
  const spotPrice = inventory > 0n ? Number(x) / Number(inventory) : lastPrice;
  const averageExecutionPrice = quote > 0n && amountWei > 0n ? side === "buy" ? Number(amountWei) / Number(quote) : Number(quote) / Number(amountWei) : 0;
  const priceImpact = spotPrice > 0 && averageExecutionPrice > 0 ? Math.abs(averageExecutionPrice - spotPrice) / spotPrice * 100 : 0;
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
    } catch (error) { setStatus(describeTxError(error)); }
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
    } catch (error) { setStatus(describeTxError(error)); }
  }
  // Real, disclosed safety signals — never a fabricated authoritative score.
  // Mint/freeze are static facts about every PumpToken (fixed supply at
  // construction, no owner-privileged function exists in the contract at
  // all), the rest are read from live state.
  const totalSupplyWei = 1_000_000_000n * 10n ** 18n;
  // The bonding curve (or post-graduation liquidity pool) is an inventory
  // venue, not an external holder. Keep it in the Holders distribution so
  // the token allocation is complete, but exclude it from the wallet
  // concentration safety signal. Otherwise every pre-graduation coin would
  // report its unsold curve inventory as the "top holder" by definition.
  const topExternalHolder = asset.topHolders?.find((holder) => !holder.kind)
  const topHolderShare = topExternalHolder
    ? Number((BigInt(topExternalHolder.balance) * 10_000n) / totalSupplyWei) / 100
    : null;
  const lpCheck: boolean | null = graduated ? (pairIsV3 || burnedPct >= 99.99) : null;
  const safetyChecks: Array<{ label: string; ok: boolean | null; value: string }> = [
    { label: "Mint authority", ok: true, value: "No mint function" },
    { label: "Freeze authority", ok: true, value: "No freeze function" },
    { label: "LP status", ok: lpCheck, value: graduated ? (pairIsV3 ? "Locked (NFT)" : lpCheck ? "Locked (burned)" : "Verify onchain") : "N/A — pre-graduation" },
    { label: "Contract", ok: isMainnet ? verified : null, value: isMainnet ? (verified === null ? "Checking…" : verified ? "Verified" : "Unverified") : "Not tracked (testnet)" },
    { label: "Top holder", ok: topHolderShare === null ? null : topHolderShare < 20, value: topHolderShare === null ? "No data yet" : `${topHolderShare.toFixed(1)}%` },
  ];
  const scoredChecks = safetyChecks.filter((check) => check.ok !== null);
  const safetyScore = scoredChecks.length ? Math.round((scoredChecks.filter((check) => check.ok).length / scoredChecks.length) * 100) : null;
  const agoLabel = (seconds: number) => {
    if (!seconds) return "—";
    const delta = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
    if (delta < 60) return `${delta}s ago`;
    if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
    if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
    return `${Math.floor(delta / 86400)}d ago`;
  };
  const chainTag = isMainnet ? "MAINNET" : "TESTNET";
  const feedLabel = tapeHealth === "live" ? "Live" : tapeHealth === "delayed" ? "Delayed" : "Offline";

  return (
    <section className="coin-page-shell">
      <div className="orbit-terminal">
        {reportOpen && <div className="report-panel"><div><strong>Report ${asset.symbol}</strong><small>Reports do not freeze a market. Include only verifiable concerns.</small></div><select value={reportCategory} onChange={(event) => setReportCategory(event.target.value)}><option value="scam">Suspected scam</option><option value="impersonation">Impersonation</option><option value="harmful-link">Harmful social link</option><option value="illegal">Illegal content</option><option value="other">Other</option></select><textarea maxLength={240} value={reportDetail} onChange={(event) => setReportDetail(event.target.value)} placeholder="Optional evidence or context (max 240 characters)"/><div><button onClick={() => setReportOpen(false)}>Cancel</button><button className="primary" onClick={() => void submitReport()}>Submit report</button></div></div>}

        <header className="orbit-top">
          <button className="orbit-back" onClick={close}>← Market</button>
          <div className="orbit-brand">
            <div className="orbit-mark"><i></i><i></i><b></b></div>
            <div className="orbit-brand-name">ARCODIAN<span>/terminal</span></div>
          </div>
          <div className="orbit-pair">
            <div className="orbit-avatar">{asset.image ? <img src={imageUrl(asset.image)} alt="" /> : asset.symbol.slice(0, 2).toUpperCase()}</div>
            <div className="orbit-pair-id">
              <div className="orbit-pair-sym">{asset.symbol} <em>/ {currency}</em></div>
              <div className="orbit-pair-name">{asset.name}</div>
            </div>
            <div className="orbit-chain-tag">{chainTag}</div>
          </div>
          <div className="orbit-top-price">
            <div className="p mono">{priceLabel(lastPrice)} {currency}</div>
            <div className={`orbit-chg mono ${asset.priceChange24h != null && asset.priceChange24h < 0 ? "neg" : "pos"}`}>{pctText(asset.priceChange24h)}</div>
          </div>
          <div className="orbit-stats">
            <div className="orbit-stat"><b>{compactNumber(Number(formatEther(marketCap)))}</b><span>Mcap</span></div>
            <div className="orbit-stat"><b>{compactNumber(Number(formatEther(dexLiquidity)))}</b><span>{graduated ? "Liq" : "Raised"}</span></div>
            <div className="orbit-stat hide-md"><b>{compactNumber(asset.volume ? Number(formatEther(BigInt(asset.volume))) : 0)}</b><span>Vol</span></div>
            <div className="orbit-stat hide-md"><b>{asset.holderCount || 0}</b><span>Holders</span></div>
            <div className="orbit-stat hide-md"><b>{asset.tradeCount || 0}</b><span>Trades</span></div>
          </div>
          <div className="orbit-live"><span className={`orbit-dot ${tapeHealth === "live" ? "" : tapeHealth === "delayed" ? "slow" : "off"}`}></span> {feedLabel}</div>
          <div className="orbit-actions">
            <button onClick={() => void shareCoin()}>Share</button>
            <button onClick={openShareCard}>Share card</button>
            <button onClick={() => setReportOpen((value) => !value)}>Report</button>
          </div>
        </header>

        <div className="orbit-main">
          <aside className="orbit-col orbit-col-left">
            <div className="orbit-block">
              <div className="orbit-block-h"><div className="orbit-block-t">{graduated ? "Market status" : "Bonding curve"}</div></div>
              {graduated ? <>
                <div className="orbit-curve-top"><div className="orbit-curve-pct done">Graduated</div></div>
                <div className="orbit-curve-note">Liquidity is <b>permanently locked</b> — trading now routes through {pairIsV3 ? "a real Uniswap V3 pool" : "the canonical Arcodian pair"}, the same venue any external router or bot reads.</div>
              </> : <>
                <div className="orbit-curve-top"><div className="orbit-curve-pct">{asset.progress.toFixed(1)}%</div><div className="orbit-curve-sub">to graduation</div></div>
                <div className="orbit-track"><i style={{ width: `${Math.min(100, asset.progress)}%` }}></i></div>
                <div className="orbit-curve-note"><b>{Number(formatEther(asset.threshold > reserve ? asset.threshold - reserve : 0n)).toLocaleString(undefined, { maximumFractionDigits: 2 })} {currency}</b> more in buys and this market graduates automatically. Liquidity locks the moment it does.</div>
              </>}
            </div>

            <div className="orbit-block">
              <div className="orbit-block-h"><div className="orbit-block-t">Safety scan</div>{safetyScore !== null && <div className="orbit-block-t" style={{ color: safetyScore >= 80 ? "var(--up)" : safetyScore >= 50 ? "var(--flare)" : "var(--down)" }}>{safetyScore}/100</div>}</div>
              <div className="orbit-checks">
                {safetyChecks.map((check) => (
                  <div key={check.label} className={`orbit-check ${check.ok === true ? "ok" : check.ok === false ? "warn" : "neutral"}`}>
                    <i>{check.ok === true ? "✓" : check.ok === false ? "!" : "·"}</i>{check.label}<em>{check.value}</em>
                  </div>
                ))}
              </div>
              <div className="orbit-risk-note"><span>Permissionless market — anyone can create a token here. These signals cover what's readable onchain, not a full audit. Never trade more than you can afford to lose.</span></div>
            </div>

            <div className="orbit-block">
              <div className="orbit-block-h"><div className="orbit-block-t">Market</div></div>
              <div className="orbit-rows">
                <div className="orbit-row"><span>Pair</span><b>{asset.symbol} / {currency}</b></div>
                <div className="orbit-row"><span>Supply</span><b>1,000,000,000</b></div>
                <div className="orbit-row"><span>FDV</span><b>{Number(formatEther(marketCap)).toLocaleString(undefined, { maximumFractionDigits: 2 })} {currency}</b></div>
                {graduated && <>
                  <div className="orbit-row"><span>Pooled {asset.symbol}</span><b>{Number(formatEther(inventory)).toLocaleString(undefined, { maximumFractionDigits: 0 })}</b></div>
                  <div className="orbit-row"><span>Pooled {currency}</span><b>{Number(formatEther(reserve)).toLocaleString(undefined, { maximumFractionDigits: 2 })}</b></div>
                </>}
                <div className="orbit-row"><span>Created</span><b>{agoLabel(asset.createdAt || 0)}</b></div>
              </div>
            </div>

            <div className="orbit-block" style={{ borderBottom: "none" }}>
              <div className="orbit-block-h"><div className="orbit-block-t">Contract</div></div>
              <div className="orbit-addr">
                <span>{short(asset.address)}</span>
                <button onClick={async () => { try { await navigator.clipboard.writeText(asset.address); } catch { /* clipboard unavailable */ } setCopied(true); setTimeout(() => setCopied(false), 1600); }}>{copied ? "Copied" : "Copy"}</button>
              </div>
              <div className="orbit-links">
                <a href={`${activeArc.explorer}/address/${asset.address}`} target="_blank" rel="noreferrer">Explorer ↗</a>
                <a href="/contracts">Verify ↗</a>
              </div>
              {socials && (socials.twitter || socials.discord) && (
                <div className="orbit-links" style={{ marginTop: 6 }}>
                  {socials.twitter && <a href={socials.twitter} target="_blank" rel="noreferrer noopener">X ↗</a>}
                  {socials.discord && <a href={socials.discord} target="_blank" rel="noreferrer noopener">Discord ↗</a>}
                </div>
              )}
            </div>
          </aside>

          <section className="orbit-col orbit-col-mid">
            <div className="orbit-chart-bar">
              <div className="orbit-seg">
                {([[1, "1s"], [15, "15s"], [60, "1m"], [300, "5m"], [900, "15m"], [3600, "1h"]] as const).map(([seconds, label]) => (
                  <button key={seconds} className={timeframe === seconds ? "on" : ""} onClick={() => { setTimeframe(seconds); setChartHover(null); }}>{label}</button>
                ))}
              </div>
              <button className="orbit-tool" onClick={() => setChartWindow((value) => (value === 30 ? 60 : 30))}>{chartWindow === 30 ? "More history" : "Less history"}</button>
              <div className="orbit-bar-sp"></div>
              <span className="orbit-tool mono">{priceLabel(lastPrice)} {currency}</span>
            </div>

            <div className="orbit-chart-wrap">
              {!visibleCandles.length && <div className="orbit-chart-empty"><i>⌁</i><strong>Waiting for market activity</strong><small>The first confirmed buy or sell creates a candle here automatically.</small></div>}
              <TerminalChart key={asset.address} candles={visibleCandles} priceLabel={priceLabel} onHover={setChartHover} />
            </div>

            <div className="orbit-tape">
              <div className="orbit-tabs" role="tablist" aria-label="Market data sections">
                {(["trades", "holders", "community"] as const).map((section) => (
                  <button key={section} role="tab" aria-selected={deskTab === section} className={deskTab === section ? "on" : ""} onClick={() => setDeskTab(section)}>
                    {section === "trades" ? "Trades" : section === "holders" ? "Holders" : "Community"}
                    <span className="count mono">{section === "trades" ? (asset.tradeCount || 0) : section === "holders" ? (asset.holderCount || 0) : posts.length}</span>
                  </button>
                ))}
              </div>
              <div className="orbit-tape-body">
                {deskTab === "trades" && (
                  <table>
                    <thead><tr><th>Type</th><th>{currency}</th><th>{asset.symbol}</th></tr></thead>
                    <tbody>
                      {liveTrades.length ? liveTrades.map((event, index) => (
                        <tr key={`${event.side}-${index}`}>
                          <td className={`orbit-side ${event.side === "BUY" ? "positive" : "negative"}`}>{event.side}</td>
                          <td>{formatTradeQuote(event.amount).toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                          <td>{formatTradeToken(event.tokens).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                        </tr>
                      )) : <tr><td colSpan={3} className="orbit-empty-row">No trades yet — indexed tape is {feedLabel.toLowerCase()}.</td></tr>}
                    </tbody>
                  </table>
                )}
                {deskTab === "holders" && (
                  <table>
                    <thead><tr><th>#</th><th>Wallet</th><th>Balance</th><th>Supply</th></tr></thead>
                    <tbody>
                      {(asset.topHolders || []).slice(0, 10).length ? (asset.topHolders || []).slice(0, 10).map((holder, index) => (
                        <tr key={holder.address}>
                          <td style={{ color: "var(--muted)" }}>{index + 1}</td>
                          <td>
                            <a className="orbit-wallet" href={`${activeArc.explorer}/address/${holder.address}`} target="_blank" rel="noreferrer">
                              {holder.kind === "bonding_curve" ? "Bonding curve" : holder.kind === "liquidity_pool" ? "Liquidity pool" : short(holder.address)}
                            </a>
                          </td>
                          <td>{Number(formatEther(BigInt(holder.balance))).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                          <td>{(Number((BigInt(holder.balance) * 10_000n) / totalSupplyWei) / 100).toFixed(2)}%</td>
                        </tr>
                      )) : <tr><td colSpan={4} className="orbit-empty-row">Holder distribution appears after indexed trades.</td></tr>}
                    </tbody>
                  </table>
                )}
                {deskTab === "community" && (
                  <div className="orbit-community">
                    <div className="orbit-compose">
                      <textarea maxLength={280} placeholder={account ? `Share a note about ${asset.symbol}…` : "Connect wallet to post"} value={postText} onChange={(event) => setPostText(event.target.value)} />
                      <button disabled={posting || !postText.trim()} onClick={() => void publishPost()}>{posting ? "Signing…" : account ? "Sign & post" : "Connect"}</button>
                    </div>
                    <div className="orbit-feed">
                      {posts.map((post) => <article key={post.id}><div><a href={`${activeArc.explorer}/address/${post.author}`} target="_blank" rel="noreferrer">{short(post.author)}</a><time>{new Date(post.timestamp * 1000).toLocaleString()}</time></div><p>{post.message}</p></article>)}
                      {!posts.length && <p style={{ color: "var(--muted)", fontSize: 12 }}>No signed community posts yet.</p>}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>

          <aside className="orbit-col orbit-col-right" id="trade-order-panel">
            <div className="orbit-block">
              <div className="orbit-sidebtn">
                <button className={`buy ${side === "buy" ? "on" : ""}`} onClick={() => { setSide("buy"); setAmount("1"); setTradeStage("idle"); setStatus(""); setTxHash(""); }}>BUY</button>
                <button className={`sell ${side === "sell" ? "on" : ""}`} onClick={() => { setSide("sell"); setAmount(""); setTradeStage("idle"); setStatus(""); setTxHash(""); }}>SELL</button>
              </div>

              <div className="orbit-field">
                <div className="orbit-field-h"><span>{side === "buy" ? "You pay" : "You sell"}</span>{side === "sell" && <span>Balance <b className="mono">{Number(formatEther(balance)).toLocaleString(undefined, { maximumFractionDigits: 4 })}</b></span>}</div>
                <div className="orbit-field-in">
                  <input inputMode="decimal" placeholder="0.0" value={amount} onChange={(e) => { setAmount(e.target.value.replace(/[^0-9.]/g, "")); setTradeStage("idle"); setStatus(""); setTxHash(""); }} />
                  <div className="orbit-unit">{side === "buy" ? currency : asset.symbol}</div>
                </div>
              </div>

              <div className="orbit-presets" aria-label={side === "buy" ? "Quick buy amounts" : "Quick sell percentages"}>
                {side === "buy"
                  ? ["25", "100", "500", "1000"].map((value) => <button key={value} onClick={() => { setAmount(value); setTradeStage("idle"); setStatus(""); }}>{value}</button>)
                  : [["25%", 25n], ["50%", 50n], ["75%", 75n], ["MAX", 100n]].map(([label, percentage]) => <button key={String(label)} onClick={() => { setAmount(formatEther((balance * BigInt(percentage)) / 100n)); setTradeStage("idle"); setStatus(""); }}>{String(label)}</button>)}
              </div>

              <div className="orbit-arrow">↓</div>

              <div className="orbit-field">
                <div className="orbit-field-h"><span>You receive (est.)</span></div>
                <div className="orbit-field-in">
                  <input readOnly value={Number(formatEther(quote)).toLocaleString(undefined, { maximumFractionDigits: 6 })} />
                  <div className="orbit-unit">{side === "buy" ? asset.symbol : currency}</div>
                </div>
              </div>

              <div className="orbit-summary">
                <div className="orbit-row"><span>Minimum received</span><b className="mono">{Number(formatEther(minimumReceived)).toLocaleString(undefined, { maximumFractionDigits: 6 })} {side === "buy" ? asset.symbol : currency}</b></div>
                <div className="orbit-row"><span>Average execution</span><b className="mono">{priceLabel(averageExecutionPrice)} {currency}/{asset.symbol}</b></div>
                <div className="orbit-row"><span>Price impact</span><b className="mono" style={{ color: priceImpact > 5 ? "var(--down)" : priceImpact > 1.5 ? "var(--flare)" : "var(--ink)" }}>{priceImpact.toLocaleString(undefined, { maximumFractionDigits: 2 })}%</b></div>
                <div className="orbit-row"><span>Venue fee</span><b className="mono">{venueFeeLabel}</b></div>
                <div className="orbit-row">
                  <span>Max slippage</span>
                  <div className="orbit-slip">
                    {["0.5", "1", "3"].map((v) => <button key={v} className={slippage === v ? "on" : ""} onClick={() => setSlippage(v)}>{v}%</button>)}
                  </div>
                </div>
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
              {insufficientBalance && <p className="orbit-error">Sell amount exceeds your {asset.symbol} balance.</p>}
              {tradeStage !== "idle" && <div className="orbit-progress" aria-live="polite">
                <span className={["quote", "approval", "submitted", "confirmed"].includes(tradeStage) ? "done" : ""}>Quote</span>
                <span className={["approval", "submitted", "confirmed"].includes(tradeStage) ? "done" : ""}>{side === "sell" ? "Approval" : "Wallet"}</span>
                <span className={["submitted", "confirmed"].includes(tradeStage) ? "done" : ""}>Onchain</span>
                <span className={tradeStage === "confirmed" ? "done" : ""}>Confirmed</span>
              </div>}

              <button className={`orbit-exec ${side === "sell" ? "sell" : ""}`} disabled={busy || !validAmount || quote <= 0n || insufficientBalance} onClick={trade}>
                {!account
                  ? "CONNECT WALLET"
                  : busy
                    ? (tradeStage === "submitted" ? "CONFIRMING ONCHAIN…" : tradeStage === "approval" ? "APPROVE IN WALLET…" : "CONFIRM IN WALLET…")
                    : `${side === "buy" ? "BUY" : "SELL"} ${asset.symbol}`}
              </button>
              {status ? <p className="orbit-status">{status}</p> : <p className="orbit-exec-note">Exact approval only · wallet-signed · non-custodial</p>}
              {txHash && <a className="orbit-txlink" href={`${activeArc.explorer}/tx/${txHash}`} target="_blank" rel="noreferrer">View transaction {short(txHash)} ↗</a>}
            </div>

            <div className="orbit-block" style={{ borderBottom: "none" }}>
              <div className="orbit-block-h"><div className="orbit-block-t">Your position</div></div>
              {balance > 0n ? (
                <div className="orbit-pos-card">
                  <div className="orbit-pos-pnl"><b className={pnl >= 0n ? "positive" : "negative"}>{pnl >= 0n ? "+" : ""}{Number(formatEther(pnl)).toLocaleString(undefined, { maximumFractionDigits: 4 })} {currency}</b></div>
                  <div className="orbit-row"><span>Size</span><b>{Number(formatEther(balance)).toLocaleString(undefined, { maximumFractionDigits: 4 })} {asset.symbol}</b></div>
                  <div className="orbit-row"><span>Value</span><b>{Number(formatEther(sellValue)).toLocaleString(undefined, { maximumFractionDigits: 4 })} {currency}</b></div>
                </div>
              ) : <div className="orbit-pos-empty">No position yet.<br />Your size and P&amp;L appear here after the first fill.</div>}
            </div>
          </aside>
        </div>

        <nav className="orbit-mob-nav">
          <button className="buy" onClick={() => { setSide("buy"); document.getElementById("trade-order-panel")?.scrollIntoView({ behavior: "smooth" }); }}>BUY {asset.symbol}</button>
          <button className="sell" onClick={() => { setSide("sell"); document.getElementById("trade-order-panel")?.scrollIntoView({ behavior: "smooth" }); }}>SELL {asset.symbol}</button>
        </nav>
      </div>
    </section>
  );
}

function Launch({
  account,
  isMainnet,
  activeArc,
  activeFactory,
  activeProvider,
  connect,
  onCreated,
}: {
  account: string;
  isMainnet: boolean;
  activeArc: typeof ARC | typeof ARC_MAINNET;
  activeFactory: string;
  activeProvider: EthereumProvider | null;
  connect: () => void;
  onCreated?: (asset: LaunchAsset) => void;
}) {
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [image, setImage] = useState("");
  const [twitter, setTwitter] = useState("");
  const [discord, setDiscord] = useState("");
  // EURC has no mainnet pump-factory yet (see task #48) — force USDC there.
  const [quoteChoice, setQuoteChoice] = useState<"USDC" | "EURC">("USDC");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const launchStep = !name.trim() || !symbol.trim() ? 1 : !image ? 2 : 3;
  const identityReady = Boolean(name.trim() && /^[A-Za-z0-9]{2,10}$/.test(symbol));
  const imageUriBytes = new TextEncoder().encode(image).length;
  // uploadImage() returns ipfs:// once Pinata is configured (the common
  // case now) and only falls back to https:// when it isn't — this used to
  // require https:// only, so every IPFS-backed upload silently failed step
  // 3 forever. imageUrl() in shared.tsx already treats ipfs:// as first-class.
  const launchReady = identityReady && /^(https:\/\/|ipfs:\/\/)/.test(image) && imageUriBytes <= 200;

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
      name.trim().length > 40 ||
      !/^[A-Za-z0-9]{2,10}$/.test(symbol) ||
      !/^(https:\/\/|ipfs:\/\/)/.test(image) ||
      imageUriBytes > 200
    ) {
      setStatus(
        imageUriBytes > 200
          ? "Image URI is too long for the launch contract. Upload the image again to create a compact IPFS URI."
          : "Enter name, 2–10 character symbol, and upload a valid image first.",
      );
      return;
    }
    setBusy(true);
    setStatus(
      `Switching to ${activeArc.name}. Review the fixed-1B image launch in your wallet.`,
    );
    try {
      await ensureWalletChain(activeProvider, activeArc);
      const provider = new BrowserProvider(activeProvider as never);
      const signer = await provider.getSigner();
      const isEurc = !isMainnet && quoteChoice === "EURC";
      const factoryAddress = (isEurc ? EURC_PUMP_FACTORY_ADDRESS : activeFactory).toLowerCase();
      const factory = new Contract(
        factoryAddress,
        ARC_PUMP_FACTORY_ABI,
        signer,
      );
      // Mobile OKX may run its own eth_estimateGas against a stale/busy
      // endpoint even after the chain switch succeeds. Use exactly one
      // canonical RPC for this preflight; the market read fallback is not
      // suitable here because one of its optional endpoints can be stale or
      // unavailable while the canonical endpoint is healthy.
      const canonical = new JsonRpcProvider(
        activeArc.rpc,
        Network.from(activeArc.id),
        { staticNetwork: Network.from(activeArc.id), batchMaxCount: 1 },
      );
      let gasLimit: bigint;
      let gasPrice: bigint;
      try {
        const creator = await signer.getAddress();
        const data = factory.interface.encodeFunctionData("createLaunch", [
          name.trim(),
          symbol.toUpperCase(),
          image,
        ]);
        const estimated = await canonical.estimateGas({
          from: creator,
          to: factoryAddress,
          data,
        });
        gasLimit = (estimated * 125n) / 100n;
        const feeData = await canonical.getFeeData();
        gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n;
        if (gasPrice <= 0n) throw new Error("Canonical RPC returned no usable gas price.");
      } finally {
        canonical.destroy();
      }
      const tx = await factory.createLaunch(
        name.trim(),
        symbol.toUpperCase(),
        image,
        { gasLimit, gasPrice },
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
          isEurc ? "function VIRTUAL_QUOTE() view returns(uint256)" : "function VIRTUAL_NATIVE() view returns(uint256)",
          "function graduationThreshold() view returns(uint256)", "function graduated() view returns(bool)"], provider);
        const token = new Contract(tokenAddress, ["function balanceOf(address) view returns(uint256)"], provider);
        const [rawReserve, rawVirtualReserve, rawThreshold, graduated, inventory] = await Promise.all([
          isEurc ? curve.realQuoteReserve() : curve.realNativeReserve(),
          isEurc ? curve.VIRTUAL_QUOTE() : curve.VIRTUAL_NATIVE(),
          curve.graduationThreshold(), curve.graduated(), token.balanceOf(curveAddress)]);
        // Normalize EURC's 6-dec collateral to the 18-dec magnitudes the UI expects.
        const scale = isEurc ? QSCALE : 1n;
        const reserve = (rawReserve as bigint) * scale;
        const virtualReserve = (rawVirtualReserve as bigint) * scale;
        const threshold = (rawThreshold as bigint) * scale;
        onCreated?.({ symbol: symbol.toUpperCase(), name: name.trim(), type: "Meme", risk: "Curve", address: tokenAddress, curve: curveAddress, image, creator: account, quoteKind: isEurc ? 1 : 0, currency: quoteChoice, progress: graduated ? 100 : Number((reserve * 10000n) / threshold) / 100, reserve, virtualReserve, threshold, inventory, graduated, tradeCount: 0, holderCount: 0, volume: "0", volume1h: "0", volume24h: "0", priceChange24h: 0, topHolders: [], trades: [] });
      }
    } catch (error) {
      setStatus(describeTxError(error));
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
          href={`${activeArc.explorer}/address/${activeFactory}`}
          target="_blank"
          rel="noreferrer"
        >
          {short(activeFactory)} ↗
        </a>
      </div>
      <div className="studio-steps">
        <span className={launchStep >= 1 ? "active" : ""}><i>01</i><b>Identity</b><small>Name and ticker</small></span>
        <span className={launchStep >= 2 ? "active" : ""}><i>02</i><b>Media</b><small>Permanent image</small></span>
        <span className={launchStep >= 3 ? "active" : ""}><i>03</i><b>Review</b><small>Wallet launch</small></span>
      </div>
      <div className="launch-hero">
        <div>
          <p className="kicker">Launch studio · {activeArc.name}</p>
          <h3>Build the coin.<br/><em>We handle the market.</em></h3>
          <p>One wallet confirmation creates a fixed-supply token and its live bonding curve. At 12,000 {quoteChoice}, liquidity graduates automatically to ARC DEX.</p>
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
        {isMainnet ? (
          <label>
            <span>Quote asset <i>Trading currency</i></span>
            <div className="quote-toggle" role="group" aria-label="Quote asset"><button type="button" className="active" disabled>USDC</button></div>
            <small>Arc Mainnet is USDC-only for now — EURC launches are still Arc Testnet only. Graduation at 12,000 USDC.</small>
          </label>
        ) : (
          <label>
            <span>Quote asset <i>Trading currency</i></span>
            <div className="quote-toggle" role="group" aria-label="Quote asset">
              <button type="button" className={quoteChoice === "USDC" ? "active" : ""} onClick={() => setQuoteChoice("USDC")}>USDC</button>
              <button type="button" className={quoteChoice === "EURC" ? "active" : ""} onClick={() => setQuoteChoice("EURC")}>EURC</button>
            </div>
            <small>Traders buy/sell your coin in {quoteChoice}. Graduation at 12,000 {quoteChoice}.</small>
          </label>
        )}
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
        <div className="preview-head"><p className="kicker">Market preview</p><span>{isMainnet ? "Mainnet" : "Testnet"}</span></div>
        <div className="preview-token-art">{image ? <img src={imageUrl(image)} alt="" /> : <b>{symbol?.[0]?.toUpperCase() || "A"}</b>}</div>
        <h4>{name.trim() || "Your coin name"}</h4>
        <strong>${symbol.toUpperCase() || "TICKER"}</strong>
        <div className="preview-market-data"><span><small>Fixed supply</small><b>1,000,000,000</b></span><span><small>Launch venue</small><b>Bonding curve</b></span><span><small>Graduation</small><b>12,000 {quoteChoice}</b></span><span><small>Liquidity</small><b>Permanent</b></span></div>
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
          {busy ? `Creating on ${activeArc.name}…` : launchReady ? "Review & create coin →" : "Complete required fields"}
        </button>
      )}
      <small>Wallet-signed · non-custodial · testnet assets only</small>
      </div>
    </div>
  );
}

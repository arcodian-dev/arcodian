import { Suspense, lazy, useEffect, useState } from "react";
import { Contract, JsonRpcProvider, formatUnits } from "ethers";
import { ARC, ARC_FX_POOL_ADDRESS } from "../config";

const FxWidget = lazy(() => import("./FxWidget"));
const LiquidityPanel = lazy(() => import("./LiquidityPanel"));

const POOL_ABI = [
  "function reserveUsdc() view returns (uint256)",
  "function reserveEurc() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
];
const read = new JsonRpcProvider(ARC.rpc, undefined, { batchMaxCount: 1 });

export type FxPool = { usdc: bigint; eurc: bigint; total: bigint };

type FxStats = {
  updatedAt: string;
  tvlUsd: number; providers: number; deposits: number; swaps: number;
  volumeUsd: number; volume7dUsd: number; lpFeesLifetimeUsd: number;
  protocolFeesUsd: number; aprPct: number; rate: number;
};

type Props = {
  account: string;
  activeProvider: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } | null;
  onConnect: () => void;
};

const usd = (value: number, digits = 2) =>
  `$${value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const money = (value: bigint | undefined, symbol: string) =>
  value === undefined ? "—" : `${Number(formatUnits(value, 6)).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${symbol}`;

export default function FxDesk({ account, activeProvider, onConnect }: Props) {
  const [view, setView] = useState<"swap" | "liquidity">("swap");
  const [pool, setPool] = useState<FxPool | null>(null);
  const [stats, setStats] = useState<FxStats | null>(null);

  useEffect(() => {
    let alive = true;
    const contract = new Contract(ARC_FX_POOL_ADDRESS, POOL_ABI, read);
    const load = () =>
      Promise.all([contract.reserveUsdc(), contract.reserveEurc(), contract.totalSupply()])
        .then(([usdcR, eurcR, total]: [bigint, bigint, bigint]) => alive && setPool({ usdc: usdcR, eurc: eurcR, total }))
        .catch(() => {});
    load();
    const id = setInterval(load, 12000);
    return () => { alive = false; clearInterval(id); };
  }, [view]);

  useEffect(() => {
    let alive = true;
    fetch("/data/fx-stats.json", { cache: "no-store" })
      .then((r) => r.json())
      .then((s: FxStats) => alive && setStats(s))
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const rate = pool && pool.usdc > 0n ? Number(pool.eurc) / Number(pool.usdc) : stats?.rate ?? 0;

  return (
    <div className="fx-desk">
      <div className="fx-pool">
        <div className="fx-pool-head">
          <span>Arc FX pool · USDC / EURC</span>
          <span className="fx-live">● Live · Testnet</span>
        </div>

        <div className="fx-pool-hero">
          <div className="fx-hero-tvl">
            <small>Total value locked</small>
            <b>{stats ? usd(stats.tvlUsd) : "—"}</b>
            <em>{money(pool?.usdc, "USDC")} + {money(pool?.eurc, "EURC")}</em>
          </div>
          <div className="fx-hero-side">
            <div><small>Est. APR</small><b className="fx-apr">{stats ? `${stats.aprPct.toFixed(2)}%` : "—"}</b><em>from realized 7d fees</em></div>
            <div><small>Liquidity providers</small><b>{stats ? stats.providers : "—"}</b><em>{stats ? `${stats.deposits} deposits` : ""}</em></div>
          </div>
        </div>

        <div className="fx-pool-grid">
          <div><small>Rate</small><b>{rate ? `1 USDC = ${rate.toFixed(4)} EURC` : "—"}</b></div>
          <div><small>Volume · all-time</small><b>{stats ? usd(stats.volumeUsd) : "—"}</b></div>
          <div><small>Fees paid to LPs</small><b>{stats ? usd(stats.lpFeesLifetimeUsd, 4) : "—"}</b></div>
          <div><small>Swaps settled</small><b>{stats ? stats.swaps.toLocaleString() : "—"}</b></div>
          <div><small>Swap fee</small><b>0.10% <em>· 0.08% to LPs</em></b></div>
        </div>
      </div>

      <div className="fx-tabs" role="tablist" aria-label="Stablecoin FX">
        <button role="tab" aria-selected={view === "swap"} className={view === "swap" ? "active" : ""} onClick={() => setView("swap")}>Swap</button>
        <button role="tab" aria-selected={view === "liquidity"} className={view === "liquidity" ? "active" : ""} onClick={() => setView("liquidity")}>Provide liquidity</button>
      </div>

      <Suspense fallback={<div className="loading-board">Loading FX…</div>}>
        {view === "swap" ? (
          <FxWidget account={account} activeProvider={activeProvider} onConnect={onConnect} />
        ) : (
          <LiquidityPanel account={account} activeProvider={activeProvider} onConnect={onConnect} pool={pool} />
        )}
      </Suspense>
    </div>
  );
}

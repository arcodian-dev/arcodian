import { Suspense, lazy, useEffect, useState } from "react";
import { Contract, formatUnits, parseUnits } from "ethers";
import { ARC_MAINNET } from "../config";
import { FX_POOL, FX_POOL_ABI, externalFxDepth, fxRead, fxRoutes } from "../fxMainnet";

const FxWidget = lazy(() => import("./FxWidget"));
const LiquidityPanel = lazy(() => import("./LiquidityPanel"));

export type FxPool = { usdc: bigint; eurc: bigint; total: bigint };

type Props = {
  account: string;
  activeProvider: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } | null;
  onConnect: () => void;
};

const amount = (value: bigint | undefined, symbol: string) =>
  value === undefined ? "—" : `${Number(formatUnits(value, 6)).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${symbol}`;
const usd = (value: number) => `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

export default function FxDesk({ account, activeProvider, onConnect }: Props) {
  const [view, setView] = useState<"swap" | "liquidity">("swap");
  const [pool, setPool] = useState<FxPool | null>(null);
  const [depth, setDepth] = useState<{ usdc: bigint; eurc: bigint } | null>(null);
  // EURC per USDC at the best executable 1-USDC route (fees included).
  const [marketRate, setMarketRate] = useState(0);

  useEffect(() => {
    let alive = true;
    const contract = new Contract(FX_POOL, FX_POOL_ABI, fxRead);
    const load = () => {
      Promise.all([contract.reserveUsdc(), contract.reserveEurc(), contract.totalSupply()])
        .then(([usdcR, eurcR, total]: [bigint, bigint, bigint]) => alive && setPool({ usdc: usdcR, eurc: eurcR, total }))
        .catch(() => {});
      externalFxDepth().then((value) => alive && setDepth(value)).catch(() => {});
      fxRoutes(true, parseUnits("1", 6))
        .then((routes) => alive && routes[0] && setMarketRate(Number(formatUnits(routes[0].amountOut, 6))))
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 20_000);
    return () => { alive = false; clearInterval(id); };
  }, [view]);

  // USD value of a USDC + EURC pair, pricing EURC at the market rate.
  const value = (usdcUnits: bigint, eurcUnits: bigint) =>
    Number(formatUnits(usdcUnits, 6)) + (marketRate ? Number(formatUnits(eurcUnits, 6)) / marketRate : 0);
  const poolEmpty = pool !== null && pool.usdc === 0n;

  return (
    <div className="fx-desk">
      <div className="fx-pool">
        <div className="fx-pool-head">
          <span>Stablecoin FX · USDC / EURC</span>
          <span className="fx-live">● Live · {ARC_MAINNET.name}</span>
        </div>

        <div className="fx-pool-hero">
          <div className="fx-hero-tvl">
            <small>Liquidity the desk routes to</small>
            <b>{depth && marketRate ? usd(value(depth.usdc + (pool?.usdc ?? 0n), depth.eurc + (pool?.eurc ?? 0n))) : "—"}</b>
            <em>Uniswap V3 {amount(depth?.usdc, "USDC")} + {amount(depth?.eurc, "EURC")}</em>
          </div>
          <div className="fx-hero-side">
            <div><small>Arcodian FX pool</small><b>{pool ? (poolEmpty ? "Open for first LP" : usd(value(pool.usdc, pool.eurc))) : "—"}</b><em>{pool && !poolEmpty ? `${amount(pool.usdc, "USDC")} + ${amount(pool.eurc, "EURC")}` : "0.08% of every swap goes to LPs"}</em></div>
          </div>
        </div>

        <div className="fx-pool-grid">
          <div><small>Market rate</small><b>{marketRate ? `1 USDC ≈ ${marketRate.toFixed(4)} EURC` : "—"}</b></div>
          <div><small>Routing</small><b>Best executable quote</b></div>
          <div><small>Arcodian pool fee</small><b>0.10% <em>· 0.08% to LPs</em></b></div>
          <div><small>Uniswap V3 route</small><b>0.30% Arcodian <em>+ pool tier</em></b></div>
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
          <LiquidityPanel account={account} activeProvider={activeProvider} onConnect={onConnect} pool={pool} marketRate={marketRate} />
        )}
      </Suspense>
    </div>
  );
}

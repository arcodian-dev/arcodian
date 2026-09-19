import { useEffect, useMemo, useState } from "react";
import { BrowserProvider, Contract, formatUnits, parseUnits } from "ethers";
import { ARC_MAINNET } from "../config";
import { ensureWalletChain } from "../shared";
import { ERC20_ABI, FX_EURC, FX_FEE_ROUTER_ABI, FX_POOL_ABI, FX_USDC, fxRead, fxRoutes, type FxRoute } from "../fxMainnet";
import { sendWithMargin } from "../txGas";

type Props = {
  account: string;
  activeProvider: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } | null;
  onConnect: () => void;
};

const SLIPPAGE_BPS = 50n; // 0.5%

export default function FxWidget({ account, activeProvider, onConnect }: Props) {
  const [usdcToEurc, setUsdcToEurc] = useState(true);
  const [amount, setAmount] = useState("");
  const [routes, setRoutes] = useState<FxRoute[]>([]);
  const [routing, setRouting] = useState(false);
  const [balances, setBalances] = useState<{ usdc: bigint; eurc: bigint } | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const inLabel = usdcToEurc ? "USDC" : "EURC";
  const outLabel = usdcToEurc ? "EURC" : "USDC";
  const amountUnits = useMemo(() => {
    try { return amount && Number(amount) > 0 ? parseUnits(amount, 6) : 0n; } catch { return 0n; }
  }, [amount]);
  const best = routes[0] || null;

  useEffect(() => {
    let alive = true;
    if (amountUnits <= 0n) { setRoutes([]); return; }
    const timer = setTimeout(async () => {
      setRouting(true);
      try {
        const found = await fxRoutes(usdcToEurc, amountUnits);
        if (alive) setRoutes(found);
      } catch {
        if (alive) setRoutes([]);
      } finally {
        if (alive) setRouting(false);
      }
    }, 300);
    return () => { alive = false; clearTimeout(timer); };
  }, [amountUnits, usdcToEurc]);

  useEffect(() => {
    let alive = true;
    if (!account) { setBalances(null); return; }
    const usdc = new Contract(FX_USDC, ERC20_ABI, fxRead);
    const eurc = new Contract(FX_EURC, ERC20_ABI, fxRead);
    Promise.all([usdc.balanceOf(account), eurc.balanceOf(account)])
      .then(([u, e]: [bigint, bigint]) => alive && setBalances({ usdc: u, eurc: e }))
      .catch(() => alive && setBalances(null));
    return () => { alive = false; };
  }, [account, status]);

  const rate = best && amountUnits > 0n ? Number(formatUnits(best.amountOut, 6)) / Number(formatUnits(amountUnits, 6)) : null;
  const minOut = best ? (best.amountOut * (10_000n - SLIPPAGE_BPS)) / 10_000n : 0n;
  const insufficient = balances ? amountUnits > (usdcToEurc ? balances.usdc : balances.eurc) : false;

  async function runSwap() {
    if (!account || !activeProvider) { onConnect(); return; }
    if (amountUnits <= 0n || !best) { setStatus("Enter an amount to swap."); return; }
    if (insufficient) { setStatus(`Not enough ${inLabel}.`); return; }
    setBusy(true);
    setStatus("");
    try {
      await ensureWalletChain(activeProvider, ARC_MAINNET);
      const signer = await new BrowserProvider(activeProvider as never).getSigner();
      const tokenIn = usdcToEurc ? FX_USDC : FX_EURC;
      const tokenOut = usdcToEurc ? FX_EURC : FX_USDC;
      // Re-quote right before signing: the pools move between keystrokes.
      const fresh = (await fxRoutes(usdcToEurc, amountUnits))[0];
      if (!fresh) throw new Error("No route available right now.");
      const guard = (fresh.amountOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;
      const allowance = (await new Contract(tokenIn, ERC20_ABI, fxRead).allowance(account, fresh.spender)) as bigint;
      if (allowance < amountUnits) {
        setStatus(`Approve ${amount} ${inLabel} in your wallet…`);
        await (await sendWithMargin(new Contract(tokenIn, ERC20_ABI, signer), "approve", [fresh.spender, amountUnits])).wait();
      }
      setStatus(`Confirm the swap through ${fresh.label}…`);
      const deadline = Math.floor(Date.now() / 1000) + 300;
      const tx = fresh.venue === "arcodian"
        ? await sendWithMargin(new Contract(fresh.spender, FX_POOL_ABI, signer), "swap", [usdcToEurc, amountUnits, guard, deadline])
        : await sendWithMargin(new Contract(fresh.spender, FX_FEE_ROUTER_ABI, signer), "swapExactInputSingle", [tokenIn, tokenOut, fresh.poolFee, amountUnits, guard, deadline]);
      await tx.wait();
      setStatus(`Swapped ${amount} ${inLabel} → ${outLabel} through ${fresh.label}.`);
      setAmount("");
      setRoutes([]);
    } catch (error) {
      const message = (error as { shortMessage?: string; message?: string })?.shortMessage || (error as Error)?.message || "Swap failed";
      setStatus(message.slice(0, 160));
    } finally {
      setBusy(false);
    }
  }

  const balance = balances ? formatUnits(usdcToEurc ? balances.usdc : balances.eurc, 6) : null;

  return (
    <div className="fx-widget">
      <div className="fx-head">
        <span className="fx-title">Stablecoin FX</span>
        <span className="fx-sub">USDC ⇄ EURC · best executable rate across Arcodian's pool and Uniswap V3 on Arc Mainnet</span>
      </div>
      <div className="fx-row">
        <label>You pay</label>
        <div className="fx-input">
          <input inputMode="decimal" placeholder="0.00" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^0-9.]/g, ""))} />
          <span className="fx-chip">{inLabel}</span>
        </div>
        {balance !== null && (
          <button type="button" className="fx-max" onClick={() => setAmount(balance)}>
            Balance {Number(balance).toLocaleString(undefined, { maximumFractionDigits: 2 })} · Max
          </button>
        )}
      </div>
      <button type="button" className="fx-flip" aria-label="Swap direction" onClick={() => { setUsdcToEurc((value) => !value); setRoutes([]); }}>⇅</button>
      <div className="fx-row">
        <label>You receive</label>
        <div className="fx-input fx-input-out">
          <input readOnly value={routing ? "Checking routes…" : best ? Number(formatUnits(best.amountOut, 6)).toFixed(4) : ""} placeholder="0.00" />
          <span className="fx-chip">{outLabel}</span>
        </div>
        {best && rate !== null && (
          <small className="fx-rate">
            Best route: {best.label} · 1 {inLabel} ≈ {rate.toFixed(4)} {outLabel} · fee {best.feeLabel} · min received {Number(formatUnits(minOut, 6)).toFixed(4)}
          </small>
        )}
        {routes.length > 1 && (
          <small className="fx-rate">
            Also checked: {routes.slice(1).map((route) => `${route.label} ${Number(formatUnits(route.amountOut, 6)).toFixed(4)}`).join(" · ")}
          </small>
        )}
        {!routing && amountUnits > 0n && !best && <small className="fx-rate">No route can fill this size right now.</small>}
      </div>
      <button type="button" className="fx-cta" disabled={busy || (Boolean(account) && (!best || insufficient))} onClick={runSwap}>
        {busy ? "Working…" : !account ? "Connect wallet" : insufficient ? `Not enough ${inLabel}` : `Swap ${inLabel} → ${outLabel}`}
      </button>
      {status && <p className="fx-status">{status}</p>}
    </div>
  );
}

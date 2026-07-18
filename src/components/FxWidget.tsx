import { useEffect, useMemo, useState } from "react";
import { BrowserProvider, Contract, JsonRpcProvider, formatUnits, parseUnits } from "ethers";
import { ARC, ARC_FX_POOL_ADDRESS, ARC_USDC_ERC20, ARC_EURC_ADDRESS } from "../config";

const FX_ABI = [
  "function quote(bool usdcToEurc, uint256 amountIn) view returns (uint256)",
  "function swap(bool usdcToEurc, uint256 amountIn, uint256 minOut, uint64 deadline) returns (uint256)",
  "function reserveUsdc() view returns (uint256)",
  "function reserveEurc() view returns (uint256)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

type Props = {
  account: string;
  activeProvider: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } | null;
  onConnect: () => void;
};

const read = new JsonRpcProvider(ARC.rpc, undefined, { batchMaxCount: 1 });

export default function FxWidget({ account, activeProvider, onConnect }: Props) {
  const [usdcToEurc, setUsdcToEurc] = useState(true);
  const [amount, setAmount] = useState("");
  const [out, setOut] = useState<bigint | null>(null);
  const [balances, setBalances] = useState<{ usdc: bigint; eurc: bigint } | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const inLabel = usdcToEurc ? "USDC" : "EURC";
  const outLabel = usdcToEurc ? "EURC" : "USDC";
  const amountUnits = useMemo(() => {
    try {
      return amount && Number(amount) > 0 ? parseUnits(amount, 6) : 0n;
    } catch {
      return 0n;
    }
  }, [amount]);

  useEffect(() => {
    let alive = true;
    if (amountUnits <= 0n) {
      setOut(null);
      return;
    }
    const pool = new Contract(ARC_FX_POOL_ADDRESS, FX_ABI, read);
    const timer = setTimeout(() => {
      pool.quote(usdcToEurc, amountUnits)
        .then((value: bigint) => alive && setOut(value))
        .catch(() => alive && setOut(null));
    }, 200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [amountUnits, usdcToEurc]);

  useEffect(() => {
    let alive = true;
    if (!account) {
      setBalances(null);
      return;
    }
    const usdc = new Contract(ARC_USDC_ERC20, ERC20_ABI, read);
    const eurc = new Contract(ARC_EURC_ADDRESS, ERC20_ABI, read);
    Promise.all([usdc.balanceOf(account), eurc.balanceOf(account)])
      .then(([u, e]: [bigint, bigint]) => alive && setBalances({ usdc: u, eurc: e }))
      .catch(() => alive && setBalances(null));
    return () => {
      alive = false;
    };
  }, [account, status]);

  const rate = out && amountUnits > 0n ? Number(formatUnits(out, 6)) / Number(formatUnits(amountUnits, 6)) : null;

  async function runSwap() {
    if (!account || !activeProvider) {
      onConnect();
      return;
    }
    if (amountUnits <= 0n || !out || out <= 0n) {
      setStatus("Enter an amount to swap.");
      return;
    }
    setBusy(true);
    setStatus("");
    try {
      await activeProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ARC.hexId }] });
      const signer = await new BrowserProvider(activeProvider as never).getSigner();
      const tokenInAddress = usdcToEurc ? ARC_USDC_ERC20 : ARC_EURC_ADDRESS;
      const tokenIn = new Contract(tokenInAddress, ERC20_ABI, signer);
      const allowance: bigint = await tokenIn.allowance(account, ARC_FX_POOL_ADDRESS);
      if (allowance < amountUnits) {
        setStatus(`Approving ${inLabel}…`);
        await (await tokenIn.approve(ARC_FX_POOL_ADDRESS, amountUnits)).wait();
      }
      const minOut = (out * 995n) / 1000n; // 0.5% slippage guard
      const deadline = Math.floor(Date.now() / 1000) + 300;
      const pool = new Contract(ARC_FX_POOL_ADDRESS, FX_ABI, signer);
      setStatus(`Swapping ${inLabel} → ${outLabel}…`);
      await (await pool.swap(usdcToEurc, amountUnits, minOut, deadline)).wait();
      setStatus(`Swapped ${amount} ${inLabel} → ${outLabel}.`);
      setAmount("");
      setOut(null);
    } catch (error) {
      setStatus(error instanceof Error ? error.message.slice(0, 140) : "Swap failed");
    } finally {
      setBusy(false);
    }
  }

  const balance = balances ? formatUnits(usdcToEurc ? balances.usdc : balances.eurc, 6) : null;

  return (
    <div className="fx-widget">
      <div className="fx-head">
        <span className="fx-title">Stablecoin FX</span>
        <span className="fx-sub">USDC ⇄ EURC · on-chain · 0.10% fee (0.08% to LPs)</span>
      </div>
      <div className="fx-row">
        <label>You pay</label>
        <div className="fx-input">
          <input
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(event) => setAmount(event.target.value.replace(/[^0-9.]/g, ""))}
          />
          <span className="fx-chip">{inLabel}</span>
        </div>
        {balance !== null && (
          <button type="button" className="fx-max" onClick={() => setAmount(balance)}>
            Balance {Number(balance).toLocaleString(undefined, { maximumFractionDigits: 2 })} · Max
          </button>
        )}
      </div>
      <button
        type="button"
        className="fx-flip"
        aria-label="Swap direction"
        onClick={() => {
          setUsdcToEurc((value) => !value);
          setOut(null);
        }}
      >
        ⇅
      </button>
      <div className="fx-row">
        <label>You receive</label>
        <div className="fx-input fx-input-out">
          <input readOnly value={out !== null ? Number(formatUnits(out, 6)).toFixed(4) : ""} placeholder="0.00" />
          <span className="fx-chip">{outLabel}</span>
        </div>
        {rate !== null && (
          <small className="fx-rate">
            1 {inLabel} ≈ {rate.toFixed(4)} {outLabel} · min received {(Number(formatUnits(out ?? 0n, 6)) * 0.995).toFixed(4)}
          </small>
        )}
      </div>
      <button type="button" className="fx-cta" disabled={busy} onClick={runSwap}>
        {busy ? "Working…" : !account ? "Connect wallet" : `Swap ${inLabel} → ${outLabel}`}
      </button>
      {status && <p className="fx-status">{status}</p>}
    </div>
  );
}

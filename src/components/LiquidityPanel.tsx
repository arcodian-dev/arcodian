import { useEffect, useState } from "react";
import { BrowserProvider, Contract, JsonRpcProvider, formatUnits, parseUnits } from "ethers";
import { ARC, ARC_FX_POOL_ADDRESS, ARC_USDC_ERC20, ARC_EURC_ADDRESS } from "../config";

const POOL_ABI = [
  "function addLiquidity(uint256,uint256,uint256,uint64) returns (uint256)",
  "function removeLiquidity(uint256,uint256,uint256,uint64) returns (uint256,uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function reserveUsdc() view returns (uint256)",
  "function reserveEurc() view returns (uint256)",
];
const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

const read = new JsonRpcProvider(ARC.rpc, undefined, { batchMaxCount: 1 });

type Position = { shares: bigint; usdcValue: bigint; eurcValue: bigint; sharePct: number };

type Props = {
  account: string;
  activeProvider: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } | null;
  onConnect: () => void;
};

export default function LiquidityPanel({ account, activeProvider, onConnect }: Props) {
  const [usdcAmount, setUsdcAmount] = useState("");
  const [eurcAmount, setEurcAmount] = useState("");
  const [position, setPosition] = useState<Position | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!account) { setPosition(null); return; }
    const pool = new Contract(ARC_FX_POOL_ADDRESS, POOL_ABI, read);
    Promise.all([pool.balanceOf(account), pool.totalSupply(), pool.reserveUsdc(), pool.reserveEurc()])
      .then(([shares, total, ru, re]: [bigint, bigint, bigint, bigint]) => {
        if (!alive) return;
        if (total === 0n || shares === 0n) { setPosition(null); return; }
        setPosition({
          shares,
          usdcValue: (shares * ru) / total,
          eurcValue: (shares * re) / total,
          sharePct: Number((shares * 10000n) / total) / 100,
        });
      })
      .catch(() => alive && setPosition(null));
    return () => { alive = false; };
  }, [account, status]);

  async function addLiquidity() {
    if (!account || !activeProvider) { onConnect(); return; }
    let usdcUnits: bigint;
    let eurcUnits: bigint;
    try {
      usdcUnits = parseUnits(usdcAmount || "0", 6);
      eurcUnits = parseUnits(eurcAmount || "0", 6);
    } catch { setStatus("Enter valid amounts."); return; }
    if (usdcUnits <= 0n || eurcUnits <= 0n) { setStatus("Enter both amounts."); return; }

    setBusy(true);
    setStatus("");
    try {
      await activeProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ARC.hexId }] });
      const signer = await new BrowserProvider(activeProvider as never).getSigner();
      for (const [address, units, label] of [
        [ARC_USDC_ERC20, usdcUnits, "USDC"] as const,
        [ARC_EURC_ADDRESS, eurcUnits, "EURC"] as const,
      ]) {
        const token = new Contract(address, ERC20_ABI, signer);
        const allowance: bigint = await token.allowance(account, ARC_FX_POOL_ADDRESS);
        if (allowance < units) {
          setStatus(`Approving ${label}…`);
          await (await token.approve(ARC_FX_POOL_ADDRESS, units)).wait();
        }
      }
      const pool = new Contract(ARC_FX_POOL_ADDRESS, POOL_ABI, signer);
      const deadline = Math.floor(Date.now() / 1000) + 600;
      setStatus("Adding liquidity…");
      await (await pool.addLiquidity(usdcUnits, eurcUnits, 1, deadline)).wait();
      setStatus("Liquidity added.");
      setUsdcAmount("");
      setEurcAmount("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message.slice(0, 140) : "Add liquidity failed");
    } finally {
      setBusy(false);
    }
  }

  async function removeAll() {
    if (!account || !activeProvider || !position) { onConnect(); return; }
    setBusy(true);
    setStatus("");
    try {
      await activeProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ARC.hexId }] });
      const signer = await new BrowserProvider(activeProvider as never).getSigner();
      const pool = new Contract(ARC_FX_POOL_ADDRESS, POOL_ABI, signer);
      const deadline = Math.floor(Date.now() / 1000) + 600;
      setStatus("Removing liquidity…");
      await (await pool.removeLiquidity(position.shares, 1, 1, deadline)).wait();
      setStatus("Liquidity removed — principal plus your share of fees.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message.slice(0, 140) : "Remove liquidity failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lp-panel">
      <div className="lp-head">
        <span className="lp-title">Provide liquidity</span>
        <span className="lp-sub">Earn 0.08% of every swap, in proportion to your share</span>
      </div>

      {position && (
        <div className="lp-position">
          <span><small>Your share</small><b>{position.sharePct.toFixed(2)}%</b></span>
          <span><small>Value</small><b>
            {Number(formatUnits(position.usdcValue, 6)).toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC
            {" + "}
            {Number(formatUnits(position.eurcValue, 6)).toLocaleString(undefined, { maximumFractionDigits: 2 })} EURC
          </b></span>
          <button type="button" className="lp-remove" disabled={busy} onClick={removeAll}>
            Withdraw everything
          </button>
        </div>
      )}

      <div className="lp-inputs">
        <label>
          USDC
          <input inputMode="decimal" placeholder="0.00" value={usdcAmount}
            onChange={(event) => setUsdcAmount(event.target.value.replace(/[^0-9.]/g, ""))} />
        </label>
        <label>
          EURC
          <input inputMode="decimal" placeholder="0.00" value={eurcAmount}
            onChange={(event) => setEurcAmount(event.target.value.replace(/[^0-9.]/g, ""))} />
        </label>
      </div>

      <p className="lp-note">
        Add both sides at the pool's current ratio. Anything above that ratio stays
        in the pool and is shared among all providers — it is not returned to you.
      </p>

      <button type="button" className="lp-cta" disabled={busy} onClick={addLiquidity}>
        {busy ? "Working…" : !account ? "Connect wallet" : "Add liquidity"}
      </button>
      {status && <p className="lp-status">{status}</p>}
    </div>
  );
}

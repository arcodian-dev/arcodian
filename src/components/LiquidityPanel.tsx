import { useEffect, useMemo, useState } from "react";
import { BrowserProvider, Contract, JsonRpcProvider, formatUnits, parseUnits } from "ethers";
import { ARC, ARC_FX_POOL_ADDRESS, ARC_USDC_ERC20, ARC_EURC_ADDRESS } from "../config";
import type { FxPool } from "./FxDesk";

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
  "function balanceOf(address owner) view returns (uint256)",
];

const read = new JsonRpcProvider(ARC.rpc, undefined, { batchMaxCount: 1 });

/** Turn a raw revert / RPC error into something a person can act on. */
function friendlyError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const blob = `${raw} ${JSON.stringify((error as { info?: unknown; data?: unknown })?.info ?? "")}`;
  if (/ACTION_REJECTED|user rejected|User denied|4001/i.test(blob)) return "You rejected the request in your wallet.";
  if (/insufficient funds|gas required|exceeds balance/i.test(blob)) return "Not enough USDC to cover gas.";
  if (/SLIPPAGE/.test(blob)) return "Amount too small for the pool's current ratio — try larger amounts.";
  if (/EXPIRED/.test(blob)) return "Request expired before confirming — try again.";
  if (/ZERO_AMOUNT/.test(blob)) return "Enter an amount on both sides.";
  if (/MIN_LIQUIDITY/.test(blob)) return "First deposit into the pool must be larger.";
  if (/USDC_IN|EURC_IN|transfer/i.test(blob)) return "Token transfer failed — check your USDC/EURC balance and approval.";
  if (/BAD_SHARES/.test(blob)) return "You don't hold that many LP shares.";
  return raw.slice(0, 140) || "Transaction failed";
}

type Position = { shares: bigint; usdcValue: bigint; eurcValue: bigint; sharePct: number };
type Basis = { usdc: bigint; eurc: bigint };

const basisKey = (account: string) => `arc-fx-basis-${account.toLowerCase()}`;
function readBasis(account: string): Basis | null {
  try {
    const raw = localStorage.getItem(basisKey(account));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { usdc: string; eurc: string };
    return { usdc: BigInt(parsed.usdc), eurc: BigInt(parsed.eurc) };
  } catch { return null; }
}
function writeBasis(account: string, basis: Basis) {
  localStorage.setItem(basisKey(account), JSON.stringify({ usdc: basis.usdc.toString(), eurc: basis.eurc.toString() }));
}

type Props = {
  account: string;
  activeProvider: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } | null;
  onConnect: () => void;
  pool?: FxPool | null;
};

const fmt = (value: bigint, digits = 2) =>
  Number(formatUnits(value, 6)).toLocaleString(undefined, { maximumFractionDigits: digits });

export default function LiquidityPanel({ account, activeProvider, onConnect, pool }: Props) {
  const [usdcAmount, setUsdcAmount] = useState("");
  const [eurcAmount, setEurcAmount] = useState("");
  const [position, setPosition] = useState<Position | null>(null);
  const [basis, setBasis] = useState<Basis | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  // EURC per USDC, from live reserves — used to keep the two inputs at the pool ratio.
  const ratio = useMemo(() => (pool && pool.usdc > 0n ? Number(pool.eurc) / Number(pool.usdc) : 0), [pool]);

  useEffect(() => {
    let alive = true;
    if (!account) { setPosition(null); setBasis(null); return; }
    setBasis(readBasis(account));
    const contract = new Contract(ARC_FX_POOL_ADDRESS, POOL_ABI, read);
    Promise.all([contract.balanceOf(account), contract.totalSupply(), contract.reserveUsdc(), contract.reserveEurc()])
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

  // Editing one side fills the other at the pool ratio, so nothing is donated as excess.
  function onUsdc(value: string) {
    const clean = value.replace(/[^0-9.]/g, "");
    setUsdcAmount(clean);
    if (ratio && clean && Number(clean) > 0) {
      setEurcAmount((Number(clean) * ratio).toFixed(6).replace(/\.?0+$/, ""));
    } else if (!clean) setEurcAmount("");
  }
  function onEurc(value: string) {
    const clean = value.replace(/[^0-9.]/g, "");
    setEurcAmount(clean);
    if (ratio && clean && Number(clean) > 0) {
      setUsdcAmount((Number(clean) / ratio).toFixed(6).replace(/\.?0+$/, ""));
    } else if (!clean) setUsdcAmount("");
  }

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
      const usdcToken = new Contract(ARC_USDC_ERC20, ERC20_ABI, read);
      const eurcToken = new Contract(ARC_EURC_ADDRESS, ERC20_ABI, read);
      const [usdcBal, eurcBal] = await Promise.all([
        usdcToken.balanceOf(account) as Promise<bigint>,
        eurcToken.balanceOf(account) as Promise<bigint>,
      ]);
      const short: string[] = [];
      if (usdcBal < usdcUnits) short.push(`USDC (have ${formatUnits(usdcBal, 6)})`);
      if (eurcBal < eurcUnits) short.push(`EURC (have ${formatUnits(eurcBal, 6)})`);
      if (short.length) { setStatus(`Not enough ${short.join(" and ")} in your wallet.`); setBusy(false); return; }

      await activeProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ARC.hexId }] });
      const signer = await new BrowserProvider(activeProvider as never).getSigner();
      for (const [address, units, label] of [
        [ARC_USDC_ERC20, usdcUnits, "USDC"] as const,
        [ARC_EURC_ADDRESS, eurcUnits, "EURC"] as const,
      ]) {
        // Read allowance through the app's own RPC, not the wallet's — some wallet
        // RPC endpoints return "missing revert data" on plain view calls.
        const allowance = (await new Contract(address, ERC20_ABI, read).allowance(account, ARC_FX_POOL_ADDRESS)) as bigint;
        if (allowance < units) {
          setStatus(`Approving ${label}…`);
          const token = new Contract(address, ERC20_ABI, signer);
          await (await token.approve(ARC_FX_POOL_ADDRESS, units, { gasLimit: 120000n })).wait();
        }
      }
      const poolContract = new Contract(ARC_FX_POOL_ADDRESS, POOL_ABI, signer);
      const deadline = Math.floor(Date.now() / 1000) + 600;
      setStatus("Adding liquidity…");
      await (await poolContract.addLiquidity(usdcUnits, eurcUnits, 1, deadline, { gasLimit: 500000n })).wait();
      // Track cost basis locally so we can show fees accrued on top of principal.
      const prev = readBasis(account) ?? { usdc: 0n, eurc: 0n };
      const next = { usdc: prev.usdc + usdcUnits, eurc: prev.eurc + eurcUnits };
      writeBasis(account, next); setBasis(next);
      setStatus("Liquidity added.");
      setUsdcAmount("");
      setEurcAmount("");
    } catch (error) {
      setStatus(friendlyError(error));
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
      const poolContract = new Contract(ARC_FX_POOL_ADDRESS, POOL_ABI, signer);
      const deadline = Math.floor(Date.now() / 1000) + 600;
      setStatus("Removing liquidity…");
      await (await poolContract.removeLiquidity(position.shares, 1, 1, deadline, { gasLimit: 400000n })).wait();
      localStorage.removeItem(basisKey(account)); setBasis(null);
      setStatus("Liquidity removed — principal plus your share of fees.");
    } catch (error) {
      setStatus(friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  // Fees accrued = redeemable now − what you put in (per token). Stablecoin pair,
  // so impermanent loss is negligible; the delta is essentially earned fees.
  const feeUsdc = position && basis ? position.usdcValue - basis.usdc : null;
  const feeEurc = position && basis ? position.eurcValue - basis.eurc : null;
  const hasFees = feeUsdc !== null && feeEurc !== null && (feeUsdc > 0n || feeEurc > 0n);

  return (
    <div className="lp-panel">
      <div className="lp-head">
        <span className="lp-title">Provide liquidity</span>
        <span className="lp-sub">Earn 0.08% of every swap, in proportion to your share</span>
      </div>

      {position ? (
        <div className="lp-position">
          <span><small>Your share</small><b>{position.sharePct.toFixed(2)}%</b></span>
          <span><small>Redeemable now</small><b>{fmt(position.usdcValue)} USDC + {fmt(position.eurcValue)} EURC</b></span>
          {hasFees && (
            <span className="lp-fees"><small>Fees earned (est.)</small><b>
              +{fmt(feeUsdc as bigint, 4)} USDC + {fmt(feeEurc as bigint, 4)} EURC
            </b></span>
          )}
          <button type="button" className="lp-remove" disabled={busy} onClick={removeAll}>
            Withdraw everything
          </button>
        </div>
      ) : account ? (
        <p className="lp-empty-note">You have no liquidity in this pool yet.</p>
      ) : null}

      <div className="lp-inputs">
        <label>
          USDC
          <input inputMode="decimal" placeholder="0.00" value={usdcAmount}
            onChange={(event) => onUsdc(event.target.value)} />
        </label>
        <label>
          EURC
          <input inputMode="decimal" placeholder="0.00" value={eurcAmount}
            onChange={(event) => onEurc(event.target.value)} />
        </label>
      </div>

      <p className="lp-note">
        {ratio
          ? "Both sides are matched to the pool's current ratio automatically, so none of your deposit is left behind."
          : "Add both sides at the pool's current ratio. Anything above that ratio stays in the pool and is shared among all providers."}
      </p>

      <button type="button" className="lp-cta" disabled={busy} onClick={addLiquidity}>
        {busy ? "Working…" : !account ? "Connect wallet" : "Add liquidity"}
      </button>
      {status && <p className="lp-status">{status}</p>}
    </div>
  );
}

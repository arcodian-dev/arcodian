import { useEffect, useMemo, useState } from "react";
import { BrowserProvider, Contract, formatUnits, parseUnits } from "ethers";
import { ARC, ARC_MAINNET } from "../config";
import { arcProvider } from "../shared";
import { shortAddress } from "../dex";
import { ERC20_META_ABI, PAIR_ABI, readToken, type TokenMeta } from "../dexReads";

type Position = {
  pair: string;
  token0: TokenMeta;
  token1: TokenMeta;
  shares: bigint;
  value0: bigint;
  value1: bigint;
  sharePct: number;
};

export default function PoolsPanel({ account, activeProvider, onConnect, initialPair = "", chainId }: {
  account: string;
  activeProvider: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } | null;
  onConnect: () => void;
  /** Pre-filled when the portfolio hands a specific pool over to manage. */
  initialPair?: string;
  chainId?: number | null;
}) {
  const isMainnet = chainId == null || chainId === ARC_MAINNET.id;
  const activeArc = isMainnet ? ARC_MAINNET : ARC;
  const read = useMemo(() => arcProvider(activeArc), [activeArc]);
  const [pairAddress, setPairAddress] = useState(initialPair);
  const [position, setPosition] = useState<Position | null>(null);
  const [amount0, setAmount0] = useState("");
  const [amount1, setAmount1] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const address = pairAddress.trim();
    if (!account || !/^0x[0-9a-fA-F]{40}$/.test(address)) { setPosition(null); return; }
    (async () => {
      try {
        const pair = new Contract(address, PAIR_ABI, read);
        const [t0, t1, shares, total, r0, r1] = await Promise.all([
          pair.token0(), pair.token1(), pair.balanceOf(account),
          pair.totalSupply(), pair.reserve0(), pair.reserve1(),
        ]);
        const [token0, token1] = await Promise.all([
          readToken(read, t0 as string), readToken(read, t1 as string),
        ]);
        if (!alive) return;
        const supply = total as bigint;
        const held = shares as bigint;
        setPosition({
          pair: address, token0, token1, shares: held,
          value0: supply > 0n ? (held * (r0 as bigint)) / supply : 0n,
          value1: supply > 0n ? (held * (r1 as bigint)) / supply : 0n,
          sharePct: supply > 0n ? Number((held * 10000n) / supply) / 100 : 0,
        });
      } catch { if (alive) setPosition(null); }
    })();
    return () => { alive = false; };
  }, [account, pairAddress, status, read]);

  async function withSigner(run: (signer: never) => Promise<void>) {
    if (!account || !activeProvider) { onConnect(); return; }
    setBusy(true);
    setStatus("");
    try {
      await activeProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: activeArc.hexId }] });
      const signer = await new BrowserProvider(activeProvider as never).getSigner();
      await run(signer as never);
    } catch (error) {
      setStatus(error instanceof Error ? error.message.slice(0, 140) : "Transaction failed");
    } finally {
      setBusy(false);
    }
  }

  async function addLiquidity() {
    if (!position) return;
    await withSigner(async (signer) => {
      const units0 = parseUnits(amount0 || "0", position.token0.decimals);
      const units1 = parseUnits(amount1 || "0", position.token1.decimals);
      if (units0 <= 0n || units1 <= 0n) { setStatus("Enter both amounts."); return; }
      for (const [token, units] of [[position.token0, units0], [position.token1, units1]] as const) {
        const erc20 = new Contract(token.address, ERC20_META_ABI, signer);
        if (((await erc20.allowance(account, position.pair)) as bigint) < units) {
          setStatus(`Approving ${token.symbol}…`);
          await (await erc20.approve(position.pair, units)).wait();
        }
      }
      setStatus("Adding liquidity…");
      const deadline = Math.floor(Date.now() / 1000) + 600;
      await (await new Contract(position.pair, PAIR_ABI, signer).addLiquidity(units0, units1, 1, deadline)).wait();
      setStatus("Liquidity added.");
      setAmount0(""); setAmount1("");
    });
  }

  async function withdrawAll() {
    if (!position || position.shares <= 0n) return;
    await withSigner(async (signer) => {
      setStatus("Withdrawing…");
      const deadline = Math.floor(Date.now() / 1000) + 600;
      await (await new Contract(position.pair, PAIR_ABI, signer)
        .removeLiquidity(position.shares, 1, 1, deadline)).wait();
      setStatus("Withdrawn — principal plus your share of fees.");
    });
  }

  return (
    <div className="dex-panel">
      <label className="dex-label">Pool address</label>
      <input spellCheck={false} placeholder="0x…" value={pairAddress}
        onChange={(event) => setPairAddress(event.target.value)} />

      {position && (
        <>
          <div className="dex-summary">
            <span><small>Pair</small><b>
              {position.token0.symbol} <i>{shortAddress(position.token0.address)}</i>
              {" / "}
              {position.token1.symbol} <i>{shortAddress(position.token1.address)}</i>
            </b></span>
            <span><small>Your share</small><b>{position.sharePct.toFixed(2)}%</b></span>
            <span><small>Value</small><b>
              {Number(formatUnits(position.value0, position.token0.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 })} {position.token0.symbol}
              {" + "}
              {Number(formatUnits(position.value1, position.token1.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 })} {position.token1.symbol}
            </b></span>
          </div>

          <div className="dex-amount">
            <label>{position.token0.symbol} amount</label>
            <input inputMode="decimal" value={amount0}
              onChange={(event) => setAmount0(event.target.value.replace(/[^0-9.]/g, ""))} />
          </div>
          <div className="dex-amount">
            <label>{position.token1.symbol} amount</label>
            <input inputMode="decimal" value={amount1}
              onChange={(event) => setAmount1(event.target.value.replace(/[^0-9.]/g, ""))} />
          </div>
          <p className="dex-note">
            Add both sides at the pool's current ratio. Anything above that ratio
            stays in the pool and is shared among all providers — it is not
            returned to you.
          </p>

          <button type="button" className="dex-cta" disabled={busy} onClick={addLiquidity}>
            {busy ? "Working…" : "Add liquidity"}
          </button>
          {position.shares > 0n && (
            <button type="button" className="dex-secondary" disabled={busy} onClick={withdrawAll}>
              Withdraw everything
            </button>
          )}
        </>
      )}
      {status && <p className="dex-status">{status}</p>}
    </div>
  );
}

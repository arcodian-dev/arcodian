import { useEffect, useState } from "react";
import { BrowserProvider, Contract, JsonRpcProvider, formatUnits, parseUnits } from "ethers";
import { ARC } from "../config";
import { bestQuote, shortAddress, shortfallBps, type PairQuote } from "../dex";
import { ERC20_META_ABI, PAIR_ABI, isZeroForOne, quoteAllTiers, type TokenMeta } from "../dexReads";
import { TokenField } from "./TokenField";

const read = new JsonRpcProvider(ARC.rpc, undefined, { batchMaxCount: 1 });

export default function SwapPanel({ account, activeProvider, onConnect }: {
  account: string;
  activeProvider: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } | null;
  onConnect: () => void;
}) {
  const [tokenIn, setTokenIn] = useState<TokenMeta | null>(null);
  const [tokenOut, setTokenOut] = useState<TokenMeta | null>(null);
  const [amount, setAmount] = useState("");
  const [route, setRoute] = useState<PairQuote | null>(null);
  const [slippage, setSlippage] = useState("1");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  let amountUnits = 0n;
  try {
    amountUnits = tokenIn && amount ? parseUnits(amount, tokenIn.decimals) : 0n;
  } catch {
    amountUnits = 0n;
  }

  useEffect(() => {
    let alive = true;
    if (!tokenIn || !tokenOut || amountUnits <= 0n) { setRoute(null); return; }
    const timer = setTimeout(() => {
      quoteAllTiers(read, tokenIn.address, tokenOut.address, amountUnits)
        .then((quotes) => { if (alive) setRoute(bestQuote(quotes)); })
        .catch(() => { if (alive) setRoute(null); });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [tokenIn, tokenOut, amountUnits]);

  const impact = route ? shortfallBps(amountUnits, route.out, route.reserveIn, route.reserveOut) : 0;

  async function execute() {
    if (!account || !activeProvider) { onConnect(); return; }
    if (!tokenIn || !tokenOut || !route || amountUnits <= 0n) { setStatus("Enter an amount."); return; }

    setBusy(true);
    setStatus("");
    try {
      await activeProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ARC.hexId }] });
      const signer = await new BrowserProvider(activeProvider as never).getSigner();

      const erc20 = new Contract(tokenIn.address, ERC20_META_ABI, signer);
      if (((await erc20.allowance(account, route.pair)) as bigint) < amountUnits) {
        setStatus(`Approving ${tokenIn.symbol}…`);
        await (await erc20.approve(route.pair, amountUnits)).wait();
      }

      const zeroForOne = await isZeroForOne(read, route.pair, tokenIn.address);
      const minOut = (route.out * BigInt(Math.floor((100 - Number(slippage || 0)) * 100))) / 10_000n;
      const deadline = Math.floor(Date.now() / 1000) + 600;

      setStatus("Swapping…");
      await (await new Contract(route.pair, PAIR_ABI, signer).swap(zeroForOne, amountUnits, minOut, deadline)).wait();
      setStatus(`Swapped ${amount} ${tokenIn.symbol} for ${tokenOut.symbol}.`);
      setAmount("");
      setRoute(null);
    } catch (error) {
      setStatus(error instanceof Error ? error.message.slice(0, 140) : "Swap failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dex-panel">
      <TokenField label="You pay" runner={read} value={tokenIn} onChange={setTokenIn} />
      <div className="dex-amount">
        <label>Amount</label>
        <input inputMode="decimal" placeholder="0.00" value={amount}
          onChange={(event) => setAmount(event.target.value.replace(/[^0-9.]/g, ""))} />
      </div>
      <TokenField label="You receive" runner={read} value={tokenOut} onChange={setTokenOut} />

      {route && tokenOut && (
        <div className="dex-summary">
          <span><small>You receive</small><b>
            {Number(formatUnits(route.out, tokenOut.decimals)).toLocaleString(undefined, { maximumFractionDigits: 6 })} {tokenOut.symbol}
          </b></span>
          <span><small>Fee tier</small><b>{route.tier / 100}%</b></span>
          <span className={impact >= 500 ? "dex-impact-high" : ""}>
            <small>Cost vs pool price</small><b>{(impact / 100).toFixed(2)}%</b>
          </span>
          <span><small>Pool</small><b>{shortAddress(route.pair)}</b></span>
        </div>
      )}

      {route && impact >= 500 && (
        <p className="dex-warning">
          This trade moves the pool price by {(impact / 100).toFixed(1)}%. The pool is
          thin relative to your size — you will receive noticeably less than the
          quoted pool price. Consider a smaller amount.
        </p>
      )}

      {tokenIn && tokenOut && !route && amountUnits > 0n && (
        <p className="dex-warning">No pool exists for this pair yet. Create one first.</p>
      )}

      <div className="dex-slippage">
        <label>Slippage tolerance %</label>
        <input inputMode="decimal" value={slippage}
          onChange={(event) => setSlippage(event.target.value.replace(/[^0-9.]/g, ""))} />
      </div>

      <button type="button" className="dex-cta" disabled={busy || !route} onClick={execute}>
        {busy ? "Working…" : !account ? "Connect wallet" : "Swap"}
      </button>
      {status && <p className="dex-status">{status}</p>}
    </div>
  );
}

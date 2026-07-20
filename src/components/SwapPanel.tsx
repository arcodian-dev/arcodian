import { useEffect, useState } from "react";
import { BrowserProvider, Contract, JsonRpcProvider, formatUnits, parseUnits } from "ethers";
import { ARC, ARC_ROUTER_ADDRESS, TOKENS } from "../config";
import { shortAddress, shortfallBps } from "../dex";
import { ERC20_META_ABI, PAIR_ABI, isZeroForOne, type TokenMeta } from "../dexReads";
import { findBestRoute, ROUTER_ABI } from "../routingReads";
import { routeGainBps, routeLabel, type DirectRoute, type Route } from "../routing";
import { TokenField } from "./TokenField";

const read = new JsonRpcProvider(ARC.rpc, undefined, { batchMaxCount: 1 });

/** Prefer a pinned symbol, fall back to whatever the field resolved, then the address. */
function symbolLookup(...tokens: (TokenMeta | null)[]): (address: string) => string {
  const known = new Map<string, string>();
  for (const token of TOKENS) known.set(token.address.toLowerCase(), token.symbol);
  for (const token of tokens) if (token) known.set(token.address.toLowerCase(), token.symbol);
  return (address: string) => known.get(address.toLowerCase()) ?? shortAddress(address);
}

export default function SwapPanel({ account, activeProvider, onConnect }: {
  account: string;
  activeProvider: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } | null;
  onConnect: () => void;
}) {
  const [tokenIn, setTokenIn] = useState<TokenMeta | null>(null);
  const [tokenOut, setTokenOut] = useState<TokenMeta | null>(null);
  const [amount, setAmount] = useState("");
  const [route, setRoute] = useState<Route | null>(null);
  const [direct, setDirect] = useState<DirectRoute | null>(null);
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
    if (!tokenIn || !tokenOut || amountUnits <= 0n) { setRoute(null); setDirect(null); return; }
    const timer = setTimeout(() => {
      findBestRoute(read, tokenIn.address, tokenOut.address, amountUnits)
        .then((result) => { if (alive) { setRoute(result.chosen); setDirect(result.direct); } })
        .catch(() => { if (alive) { setRoute(null); setDirect(null); } });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [tokenIn, tokenOut, amountUnits]);

  // Price impact is only meaningful for a single pool; a multi-hop route has no
  // one reserve pair. For those we show the gain over the direct route instead.
  const impact = route && route.kind === "direct"
    ? shortfallBps(amountUnits, route.out, route.reserveIn, route.reserveOut)
    : 0;
  const gain = route ? routeGainBps(route, direct) : 0;
  const symbolFor = symbolLookup(tokenIn, tokenOut);

  async function execute() {
    if (!account || !activeProvider) { onConnect(); return; }
    if (!tokenIn || !tokenOut || !route || amountUnits <= 0n) { setStatus("Enter an amount."); return; }

    setBusy(true);
    setStatus("");
    try {
      await activeProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ARC.hexId }] });
      const signer = await new BrowserProvider(activeProvider as never).getSigner();
      const minOut = (route.out * BigInt(Math.floor((100 - Number(slippage || 0)) * 100))) / 10_000n;
      const deadline = Math.floor(Date.now() / 1000) + 600;

      // The spender is the pair for a direct swap and the router for a
      // multi-hop one. Approving the wrong contract simply fails at transfer,
      // but it also strands the allowance where it is no use, so it must match.
      const spender = route.kind === "direct" ? route.pair : ARC_ROUTER_ADDRESS;
      const erc20 = new Contract(tokenIn.address, ERC20_META_ABI, signer);
      if (((await erc20.allowance(account, spender)) as bigint) < amountUnits) {
        setStatus(`Approving ${tokenIn.symbol}…`);
        await (await erc20.approve(spender, amountUnits)).wait();
      }

      setStatus("Swapping…");
      if (route.kind === "direct") {
        const zeroForOne = await isZeroForOne(read, route.pair, tokenIn.address);
        await (await new Contract(route.pair, PAIR_ABI, signer)
          .swap(zeroForOne, amountUnits, minOut, deadline)).wait();
      } else {
        await (await new Contract(ARC_ROUTER_ADDRESS, ROUTER_ABI, signer)
          .swapExactTokensForTokens(route.path, amountUnits, minOut, deadline)).wait();
      }

      setStatus(`Swapped ${amount} ${tokenIn.symbol} for ${tokenOut.symbol}.`);
      setAmount("");
      setRoute(null);
      setDirect(null);
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
          <span><small>Route</small><b>
            {route.kind === "direct" ? "Direct" : `${route.path.length - 1} hops`}
          </b></span>
          {route.kind === "direct" ? (
            <span className={impact >= 500 ? "dex-impact-high" : ""}>
              <small>Cost vs pool price</small><b>{(impact / 100).toFixed(2)}%</b>
            </span>
          ) : (
            <span><small>Better than direct</small><b>+{(gain / 100).toFixed(2)}%</b></span>
          )}
          <span><small>Path</small><b>{routeLabel(route.path, symbolFor)}</b></span>
        </div>
      )}

      {route && route.kind === "multi" && (
        <p className="dex-note">
          Routed through {routeLabel(route.path.slice(1, -1), symbolFor)} because it
          pays more than trading directly. Slippage is checked on the final amount
          you receive.
        </p>
      )}

      {route && route.kind === "direct" && impact >= 500 && (
        <p className="dex-warning">
          This trade moves the pool price by {(impact / 100).toFixed(1)}%. The pool is
          thin relative to your size — you will receive noticeably less than the
          quoted pool price. Consider a smaller amount.
        </p>
      )}

      {tokenIn && tokenOut && !route && amountUnits > 0n && (
        <p className="dex-warning">No pool or route exists for this pair yet. Create one first.</p>
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

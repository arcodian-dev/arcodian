import { useEffect, useMemo, useState } from "react";
import { BrowserProvider, Contract, JsonRpcProvider, formatUnits, parseUnits } from "ethers";
import { ARC, ARC_ROUTER_ADDRESS, TOKENS } from "../config";
import { isCircleAsset, isTokenAddress, shortAddress, shortfallBps } from "../dex";
import { ERC20_META_ABI, PAIR_ABI, isZeroForOne, readToken, type TokenMeta } from "../dexReads";
import { findBestRoute, ROUTER_ABI } from "../routingReads";
import { routeGainBps, routeLabel, type DirectRoute, type Route } from "../routing";
import { describeTxError } from "../txError";

const read = new JsonRpcProvider(ARC.rpc, undefined, { batchMaxCount: 1 });
const PINNED_TOKENS: TokenMeta[] = TOKENS.map((token) => ({ ...token }));

function prettyAmount(value: bigint, decimals: number, maximumFractionDigits = 6) {
  return Number(formatUnits(value, decimals)).toLocaleString(undefined, { maximumFractionDigits });
}

function tokenKey(token: TokenMeta) { return token.address.toLowerCase(); }

function TokenLogo({ token }: { token: TokenMeta }) {
  return <span className={`swap-token-logo swap-token-${token.symbol.toLowerCase()}`}>{token.symbol.slice(0, 1)}</span>;
}

function TokenPicker({ label, token, tokens, exclude, onChange }: {
  label: string;
  token: TokenMeta | null;
  tokens: TokenMeta[];
  exclude?: string;
  onChange: (token: TokenMeta) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [custom, setCustom] = useState<TokenMeta | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const normalized = query.trim().toLowerCase();
  const visible = tokens.filter((item) => tokenKey(item) !== exclude?.toLowerCase() && (
    !normalized || item.symbol.toLowerCase().includes(normalized) ||
    item.name.toLowerCase().includes(normalized) || tokenKey(item).includes(normalized)
  ));

  useEffect(() => {
    setCustom(null);
    setError("");
    if (!isTokenAddress(query) || tokens.some((item) => tokenKey(item) === normalized)) return;
    let alive = true;
    setLoading(true);
    readToken(read, query.trim())
      .then((result) => { if (alive) setCustom(result); })
      .catch(() => { if (alive) setError("No ERC-20 found at this address."); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [query, normalized, tokens]);

  function choose(next: TokenMeta) {
    onChange(next);
    setOpen(false);
    setQuery("");
  }

  return (
    <div className="swap-token-picker">
      <small>{label}</small>
      <button type="button" className={token ? "swap-token-button selected" : "swap-token-button"} onClick={() => setOpen(true)}>
        {token ? <><TokenLogo token={token} /><b>{token.symbol}</b><span>⌄</span></> : <><b>Select token</b><span>⌄</span></>}
      </button>
      {open && <div className="swap-modal-backdrop" role="presentation" onMouseDown={() => setOpen(false)}>
        <div className="swap-token-modal" role="dialog" aria-modal="true" aria-label={`Select ${label.toLowerCase()}`} onMouseDown={(event) => event.stopPropagation()}>
          <header><b>Select a token</b><button type="button" aria-label="Close" onClick={() => setOpen(false)}>×</button></header>
          <input autoFocus spellCheck={false} placeholder="Search name or paste address" value={query} onChange={(event) => setQuery(event.target.value)} />
          {!normalized && <div className="swap-token-pinned">{tokens.slice(0, 4).map((item) => <button type="button" key={item.address} onClick={() => choose(item)}><TokenLogo token={item} />{item.symbol}</button>)}</div>}
          <div className="swap-token-list">
            {visible.map((item) => <button type="button" key={item.address} onClick={() => choose(item)}>
              <TokenLogo token={item} /><span><b>{item.symbol}</b><small>{item.name}</small></span>
              <em>{isCircleAsset(item.address) ? "Verified" : shortAddress(item.address)}</em>
            </button>)}
            {custom && tokenKey(custom) !== exclude?.toLowerCase() && <button type="button" onClick={() => choose(custom)}>
              <TokenLogo token={custom} /><span><b>{custom.symbol}</b><small>{custom.name}</small></span><em>{shortAddress(custom.address)}</em>
            </button>}
            {loading && <p>Reading token from Arc…</p>}
            {error && <p className="token-error">{error}</p>}
            {!loading && !error && visible.length === 0 && !custom && <p>No token found. Paste its Arc contract address.</p>}
          </div>
          <footer>Always verify a token&apos;s contract address before trading.</footer>
        </div>
      </div>}
    </div>
  );
}

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
  const [tokens, setTokens] = useState<TokenMeta[]>(PINNED_TOKENS);
  const [tokenIn, setTokenIn] = useState<TokenMeta | null>(PINNED_TOKENS[0]);
  const [tokenOut, setTokenOut] = useState<TokenMeta | null>(null);
  const [amount, setAmount] = useState("");
  const [balance, setBalance] = useState<bigint | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [direct, setDirect] = useState<DirectRoute | null>(null);
  const [slippage, setSlippage] = useState("0.5");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/data/market-index.json", { cache: "no-store" }).then((response) => response.ok ? response.json() : null)
      .then((data) => {
        const launches = Array.isArray(data?.launches) ? data.launches : [];
        const discovered: TokenMeta[] = launches.filter((item: { address?: string; symbol?: string; name?: string }) =>
          isTokenAddress(item.address || "") && item.symbol && item.name
        ).map((item: { address: string; symbol: string; name: string; pair?: string }) => ({ address: item.address, symbol: item.symbol, name: item.name, decimals: 18, pair: isTokenAddress(item.pair || "") ? item.pair : undefined }));
        const merged = new Map(PINNED_TOKENS.map((item) => [tokenKey(item), item]));
        for (const item of discovered) merged.set(tokenKey(item), item);
        setTokens([...merged.values()]);
      }).catch(() => undefined);
  }, []);

  let amountUnits = 0n;
  try { amountUnits = tokenIn && amount ? parseUnits(amount, tokenIn.decimals) : 0n; } catch { amountUnits = 0n; }

  useEffect(() => {
    let alive = true;
    if (!account || !tokenIn) { setBalance(null); return; }
    new Contract(tokenIn.address, ERC20_META_ABI, read).balanceOf(account)
      .then((value: bigint) => { if (alive) setBalance(value); }).catch(() => { if (alive) setBalance(null); });
    return () => { alive = false; };
  }, [account, tokenIn]);

  useEffect(() => {
    let alive = true;
    if (!tokenIn || !tokenOut || amountUnits <= 0n) { setRoute(null); setDirect(null); return; }
    const timer = setTimeout(() => {
      findBestRoute(read, tokenIn.address, tokenOut.address, amountUnits)
        .then(async (result) => {
          if (result.chosen || !alive) return result;
          // A freshly graduated market already publishes its canonical pair in
          // the live index. Use it as an authenticated discovery fallback when
          // a browser/provider temporarily misses the factory registry read.
          const pairAddress = tokenIn.pair || tokenOut.pair;
          if (!pairAddress) return result;
          try {
            const pair = new Contract(pairAddress, PAIR_ABI, read);
            const [token0, token1, reserve0, reserve1, feeBps] = await Promise.all([
              pair.token0(), pair.token1(), pair.reserve0(), pair.reserve1(), pair.feeBps(),
            ]) as [string, string, bigint, bigint, bigint];
            const expected = new Set([tokenIn.address.toLowerCase(), tokenOut.address.toLowerCase()]);
            if (!expected.has(token0.toLowerCase()) || !expected.has(token1.toLowerCase())) return result;
            const zeroForOne = token0.toLowerCase() === tokenIn.address.toLowerCase();
            const out = await pair.quote(zeroForOne, amountUnits) as bigint;
            if (out <= 0n) return result;
            const fallback: DirectRoute = { kind: "direct", out, path: [tokenIn.address, tokenOut.address], pair: pairAddress, tier: Number(feeBps) === 10 ? 10 : 30, reserveIn: zeroForOne ? reserve0 : reserve1, reserveOut: zeroForOne ? reserve1 : reserve0 };
            return { chosen: fallback, direct: fallback };
          } catch { return result; }
        })
        .then((result) => { if (alive) { setRoute(result.chosen); setDirect(result.direct); } })
        .catch(() => { if (alive) { setRoute(null); setDirect(null); } });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [tokenIn, tokenOut, amountUnits]);

  const impact = route?.kind === "direct" ? shortfallBps(amountUnits, route.out, route.reserveIn, route.reserveOut) : 0;
  const gain = route ? routeGainBps(route, direct) : 0;
  const symbolFor = symbolLookup(tokenIn, tokenOut);
  const minOut = useMemo(() => route ? (route.out * BigInt(Math.max(0, Math.floor((100 - Number(slippage || 0)) * 100)))) / 10_000n : 0n, [route, slippage]);

  function flip() {
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    setAmount("");
    setRoute(null);
    setDirect(null);
  }

  async function execute() {
    if (!account || !activeProvider) { onConnect(); return; }
    if (!tokenIn || !tokenOut || !route || amountUnits <= 0n) { setStatus("Enter an amount."); return; }
    setBusy(true); setStatus("");
    try {
      await activeProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ARC.hexId }] });
      const signer = await new BrowserProvider(activeProvider as never).getSigner();
      const deadline = Math.floor(Date.now() / 1000) + 600;
      const spender = route.kind === "direct" ? route.pair : ARC_ROUTER_ADDRESS;
      const erc20 = new Contract(tokenIn.address, ERC20_META_ABI, signer);
      if (((await erc20.allowance(account, spender)) as bigint) < amountUnits) {
        setStatus(`Approve ${tokenIn.symbol} in your wallet`);
        await (await erc20.approve(spender, amountUnits)).wait();
      }
      setStatus("Confirm swap in your wallet");
      if (route.kind === "direct") {
        const zeroForOne = await isZeroForOne(read, route.pair, tokenIn.address);
        await (await new Contract(route.pair, PAIR_ABI, signer).swap(zeroForOne, amountUnits, minOut, deadline)).wait();
      } else {
        await (await new Contract(ARC_ROUTER_ADDRESS, ROUTER_ABI, signer).swapExactTokensForTokens(route.path, amountUnits, minOut, deadline)).wait();
      }
      setStatus(`Swap confirmed · ${amount} ${tokenIn.symbol} → ${tokenOut.symbol}`);
      setAmount(""); setRoute(null); setDirect(null);
      setBalance(await erc20.balanceOf(account) as bigint);
    } catch (error) {
      setStatus(describeTxError(error));
    } finally { setBusy(false); }
  }

  const actionLabel = busy ? "Swap pending…" : !account ? "Connect wallet" : !tokenOut ? "Choose a token" : !amountUnits ? "Enter an amount" : !route ? "No route available" : "Swap";

  return <div className="swap-pro">
    <div className="swap-pro-head"><div><b>Swap</b><small>Best price across Arcodian liquidity</small></div><button type="button" className={settingsOpen ? "active" : ""} onClick={() => setSettingsOpen(!settingsOpen)} aria-label="Swap settings">⚙</button></div>
    {settingsOpen && <div className="swap-settings"><span>Max slippage</span><div>{["0.1", "0.5", "1"].map((value) => <button type="button" className={slippage === value ? "active" : ""} onClick={() => setSlippage(value)} key={value}>{value}%</button>)}<label><input inputMode="decimal" value={slippage} onChange={(event) => setSlippage(event.target.value.replace(/[^0-9.]/g, ""))} />%</label></div></div>}

    <div className="swap-asset-card">
      <div className="swap-asset-top"><span>You pay</span>{account && tokenIn && <button type="button" onClick={() => balance !== null && setAmount(formatUnits(balance, tokenIn.decimals))}>Balance: {balance === null ? "—" : prettyAmount(balance, tokenIn.decimals, 4)} <b>MAX</b></button>}</div>
      <div className="swap-asset-main"><input aria-label="You pay amount" inputMode="decimal" placeholder="0" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^0-9.]/g, ""))} /><TokenPicker label="You pay" token={tokenIn} tokens={tokens} exclude={tokenOut?.address} onChange={setTokenIn} /></div>
      <small>{tokenIn ? shortAddress(tokenIn.address) : "Select an Arc token"}</small>
    </div>
    <button type="button" className="swap-flip" aria-label="Reverse token pair" onClick={flip}>↓</button>
    <div className="swap-asset-card receive">
      <div className="swap-asset-top"><span>You receive</span><span>{route ? "Live quote" : "—"}</span></div>
      <div className="swap-asset-main"><output>{route && tokenOut ? prettyAmount(route.out, tokenOut.decimals) : "0"}</output><TokenPicker label="You receive" token={tokenOut} tokens={tokens} exclude={tokenIn?.address} onChange={setTokenOut} /></div>
      <small>{tokenOut ? shortAddress(tokenOut.address) : "Select an Arc token"}</small>
    </div>

    {route && tokenIn && tokenOut && <div className="swap-quote-row"><span>1 {tokenIn.symbol} ≈ {prettyAmount((route.out * 10n ** BigInt(tokenIn.decimals)) / amountUnits, tokenOut.decimals)} {tokenOut.symbol}</span><button type="button" onClick={() => setDetailsOpen(!detailsOpen)}>{detailsOpen ? "Hide" : "Details"}⌄</button></div>}
    {detailsOpen && route && tokenOut && <div className="swap-details">
      <span><small>Minimum received</small><b>{prettyAmount(minOut, tokenOut.decimals)} {tokenOut.symbol}</b></span>
      <span><small>Price impact</small><b className={impact >= 500 ? "danger" : ""}>{(impact / 100).toFixed(2)}%</b></span>
      <span><small>Route</small><b>{routeLabel(route.path, symbolFor)}</b></span>
      <span><small>Liquidity source</small><b>{route.kind === "direct" ? `ArcPair · ${(route.tier / 100).toFixed(2)}%` : `${route.path.length - 1} hops · +${(gain / 100).toFixed(2)}%`}</b></span>
    </div>}
    {route?.kind === "direct" && impact >= 500 && <p className="dex-warning">High price impact: this trade moves the pool price by {(impact / 100).toFixed(1)}%. Consider a smaller amount.</p>}
    {tokenIn && tokenOut && !route && amountUnits > 0n && <p className="dex-warning">No active Arcodian pool or route exists for this pair.</p>}
    <button type="button" className="swap-primary" disabled={busy || (!!account && !route)} onClick={execute}>{actionLabel}</button>
    <div className="swap-safety"><span>◈ Arc Testnet</span><span>Non-custodial</span><span>10-minute deadline</span></div>
    {status && <p className="dex-status">{status}</p>}
  </div>;
}

import { useCallback, useEffect, useState } from "react";
import { BrowserProvider, Contract, Interface, JsonRpcProvider, formatEther, formatUnits, parseUnits } from "ethers";
import { ARC_MAINNET, ARC_MAINNET_CONTRACTS } from "../config";
import { LEND_MARKETS, OFFICIAL_ARC_ASSET_STATUS } from "../lendMarkets";
import { ensureWalletChain } from "../shared";
import { describeTxError } from "../txError";
import "./LendApp.css";

type Props = { account: string; chainId: number | null; activeProvider: EthereumProvider | null; connect: () => void; disconnect: () => void };
type Position = { supplied: string; collateral: string; borrowed: string; health: string; liquidity: string; supplyCap: string; borrowCap: string; paused: boolean; oracleFresh: boolean; utilization: string; borrowApr: string; supplyApr: string; eurUsd: string; priceAge: number; walletUsdc: string; walletEurc: string; canBorrow: string };

// Arc Lend runs on Arc Mainnet only: native USDC is lent against Circle's EURC.
const ARC_LEND_ADDRESS = ARC_MAINNET_CONTRACTS.arcLendMarket;
const ARC_LEND_COLLATERAL_ADDRESS = ARC_MAINNET_CONTRACTS.eurc;
const read = new JsonRpcProvider(ARC_MAINNET.rpc, ARC_MAINNET.id, { staticNetwork: true, batchMaxCount: 1 });
/** Block the market was deployed in; its whole event history starts here. */
const LEND_DEPLOY_BLOCK = 21_461_656;
const EVENTS = new Interface([
  "event Supplied(address indexed user, uint256 assets, uint256 shares)",
  "event Borrowed(address indexed user, uint256 amount)",
]);
type Stats = { deposits: number; borrowed: number; collateralEurc: number; tvl: number; suppliedAllTime: number; borrowedAllTime: number; users: number };

const MARKET_ABI = [
  "function supply() payable returns(uint256)", "function withdraw(uint256) returns(uint256)",
  "function depositCollateral(uint256)", "function withdrawCollateral(uint256)", "function borrow(uint256)",
  "function repay(address) payable", "function supplyShares(address) view returns(uint256)",
  "function collateralOf(address) view returns(uint256)", "function debtOf(address) view returns(uint256)",
  "function healthFactor(address) view returns(uint256)", "function totalAssets() view returns(uint256)",
  "function totalSupplyShares() view returns(uint256)", "function supplyCap() view returns(uint256)",
  "function borrowCap() view returns(uint256)", "function paused() view returns(bool)", "function oracle() view returns(address)",
  "function utilization() view returns(uint256)", "function borrowRatePerYear() view returns(uint256)", "function supplyRatePerYear() view returns(uint256)",
  "function maxOracleAge() view returns(uint256)",
  "function lastGoodPrice() view returns(uint256)", "function lastGoodPriceAt() view returns(uint64)", "function syncOracle()",
  "function totalBorrows() view returns(uint256)",
];
const TOKEN_ABI = ["function approve(address,uint256) returns(bool)", "function balanceOf(address) view returns(uint256)"];
const empty: Position = { supplied: "0.00", collateral: "0.00", borrowed: "0.00", health: "—", liquidity: "0.00", supplyCap: "5000", borrowCap: "3000", paused: false, oracleFresh: true, utilization: "0.0", borrowApr: "0.0", supplyApr: "0.0", eurUsd: "—", priceAge: 0, walletUsdc: "0", walletEurc: "0", canBorrow: "0" };
const short = (value: string) => value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "Connect wallet";

export default function LendApp({ account, chainId, activeProvider, connect, disconnect }: Props) {
  const [position, setPosition] = useState<Position>(empty);
  const [amount, setAmount] = useState("");
  const [collateral, setCollateral] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const onArc = chainId === ARC_MAINNET.id;
  const [stats, setStats] = useState<Stats | null>(null);

  // Market-wide totals and all-time volume, read from the contract and its
  // own event log (everything since the deploy block, in RPC-sized pieces).
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const market = new Contract(ARC_LEND_ADDRESS, MARKET_ABI, read);
        const [assets, borrows, priceWad, collateralRaw, head] = await Promise.all([
          market.totalAssets(), market.totalBorrows(), market.lastGoodPrice(),
          new Contract(ARC_LEND_COLLATERAL_ADDRESS, TOKEN_ABI, read).balanceOf(ARC_LEND_ADDRESS), read.getBlockNumber(),
        ]);
        const topics = [[EVENTS.getEvent("Supplied")!.topicHash, EVENTS.getEvent("Borrowed")!.topicHash]];
        const logs = [];
        for (let from = LEND_DEPLOY_BLOCK; from <= head; from += 99_000) {
          logs.push(...await read.getLogs({ address: ARC_LEND_ADDRESS, topics, fromBlock: from, toBlock: Math.min(head, from + 98_999) }));
        }
        let supplied = 0n, borrowed = 0n;
        const users = new Set<string>();
        for (const log of logs) {
          const parsed = EVENTS.parseLog(log);
          if (!parsed) continue;
          users.add(String(parsed.args.user).toLowerCase());
          if (parsed.name === "Supplied") supplied += parsed.args.assets as bigint; else borrowed += parsed.args.amount as bigint;
        }
        const price = Number(formatEther(priceWad));
        const collateralEurc = Number(formatUnits(collateralRaw, 6));
        const deposits = Number(formatEther(assets));
        if (alive) setStats({ deposits, borrowed: Number(formatEther(borrows)), collateralEurc, tvl: deposits + collateralEurc * price, suppliedAllTime: Number(formatEther(supplied)), borrowedAllTime: Number(formatEther(borrowed)), users: users.size });
      } catch { /* totals are informational; the market panel still works */ }
    };
    void load();
    const timer = window.setInterval(load, 30_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [status]);

  const refresh = useCallback(async () => {
    if (!ARC_LEND_ADDRESS) return;
    try {
      // Arc's public RPC is most reliable in browsers with one JSON-RPC call per
      // request; disabling ethers batching also keeps CORS responses predictable.
      // Always read Arc Mainnet directly, whatever network the wallet is on.
      const provider = read;
      const market = new Contract(ARC_LEND_ADDRESS, MARKET_ABI, provider);
      const [assets, totalShares, sCap, bCap, paused, utilizationWad, borrowRateWad, supplyRateWad, maxOracleAge, priceWad, priceAt] = await Promise.all([
        market.totalAssets(), market.totalSupplyShares(), market.supplyCap(), market.borrowCap(), market.paused(),
        market.utilization(), market.borrowRatePerYear(), market.supplyRatePerYear(),
        market.maxOracleAge(), market.lastGoodPrice(), market.lastGoodPriceAt(),
      ]);
      const totalAssets = BigInt(assets); const shareTotal = BigInt(totalShares);
      let supplied = 0n, userCollateral = 0n, debt = 0n, health = 0n, walletUsdc = 0n, walletEurc = 0n;
      if (account) {
        const shares = BigInt(await market.supplyShares(account));
        const [rawCollateral, rawDebt] = await Promise.all([market.collateralOf(account), market.debtOf(account)]);
        userCollateral = BigInt(rawCollateral); debt = BigInt(rawDebt);
        supplied = shareTotal === 0n ? 0n : shares * totalAssets / shareTotal;
        try { health = BigInt(await market.healthFactor(account)); } catch { health = 0n; }
        [walletUsdc, walletEurc] = await Promise.all([provider.getBalance(account), new Contract(ARC_LEND_COLLATERAL_ADDRESS, TOKEN_ABI, provider).balanceOf(account)]);
      }
      // Freshness of the price the market actually uses (synced on-chain),
      // not of the oracle itself, which always reads the current block.
      const age = Math.floor(Date.now() / 1000) - Number(priceAt);
      const collateralUsd = userCollateral * BigInt(priceWad) / 1_000_000n; // 18 dp
      const borrowLimit = collateralUsd * 70n / 100n;
      const canBorrow = borrowLimit > debt ? borrowLimit - debt : 0n;
      setPosition({ supplied: formatEther(supplied), collateral: formatUnits(userCollateral, 6), borrowed: formatEther(debt), health: debt === 0n ? "∞" : Number(formatEther(health)).toFixed(2), liquidity: formatEther(await provider.getBalance(ARC_LEND_ADDRESS)), supplyCap: formatEther(sCap), borrowCap: formatEther(bCap), paused, oracleFresh: age >= 0 && age <= Number(maxOracleAge), eurUsd: Number(formatEther(priceWad)).toFixed(4), priceAge: age, walletUsdc: formatEther(walletUsdc), walletEurc: formatUnits(walletEurc, 6), canBorrow: formatEther(canBorrow), utilization: (Number(formatEther(utilizationWad)) * 100).toFixed(1), borrowApr: (Number(formatEther(borrowRateWad)) * 100).toFixed(2), supplyApr: (Number(formatEther(supplyRateWad)) * 100).toFixed(2) });
    } catch { if (account) setStatus("Connected, but the Arc RPC could not refresh this position yet. Transactions remain wallet-confirmed."); }
  }, [account]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function switchArc() {
    if (!activeProvider) return connect();
    try { await ensureWalletChain(activeProvider, ARC_MAINNET); } catch (error) { setStatus(describeTxError(error)); }
  }

  async function syncPrice() {
    if (!account || !activeProvider) return connect();
    if (!onArc) return switchArc();
    setBusy(true); setStatus("");
    try {
      const signer = await new BrowserProvider(activeProvider).getSigner();
      const tx = await new Contract(ARC_LEND_ADDRESS, MARKET_ABI, signer).syncOracle();
      setStatus("Syncing the EUR/USD price…"); await tx.wait(); setStatus("Price synced."); await refresh();
    } catch (error) { setStatus(describeTxError(error)); }
    finally { setBusy(false); }
  }

  async function action(kind: "supply" | "withdraw" | "collateral" | "withdrawCollateral" | "borrow" | "repay") {
    if (!account || !activeProvider) return connect();
    if (!onArc) return switchArc();
    setBusy(true); setStatus("");
    try {
      const signer = await new BrowserProvider(activeProvider).getSigner();
      const market = new Contract(ARC_LEND_ADDRESS, MARKET_ABI, signer);
      let tx;
      if (kind === "supply") tx = await market.supply({ value: parseUnits(amount, 18) });
      else if (kind === "withdraw") { const shares = await market.supplyShares(account); if (shares === 0n) throw Error("No supply position to withdraw"); tx = await market.withdraw(shares); }
      else if (kind === "borrow") tx = await market.borrow(parseUnits(amount, 18));
      else if (kind === "repay") tx = await market.repay(account, { value: parseUnits(amount, 18) });
      else if (kind === "withdrawCollateral") tx = await market.withdrawCollateral(parseUnits(collateral, 6));
      else {
        const value = parseUnits(collateral, 6);
        const approval = await new Contract(ARC_LEND_COLLATERAL_ADDRESS, TOKEN_ABI, signer).approve(ARC_LEND_ADDRESS, value);
        setStatus("EURC approval submitted…"); await approval.wait();
        tx = await market.depositCollateral(value);
      }
      setStatus(`Submitted ${tx.hash.slice(0, 10)}…`); await tx.wait(); setStatus(`${kind} confirmed on Arc.`); await refresh();
    } catch (error) { setStatus(describeTxError(error)); }
    finally { setBusy(false); }
  }

  const fmt = (value: string, digits = 2) => Number(value).toLocaleString(undefined, { maximumFractionDigits: digits });
  const ageLabel = position.priceAge < 3600 ? `${Math.max(1, Math.round(position.priceAge / 60))} min ago` : `${(position.priceAge / 3600).toFixed(1)} h ago`;
  return <main className="lend-site">
    <nav><a href="/" className="lend-brand"><img src="/arcodian-mark.svg" alt=""/><span>ARCODIAN<small>ARC LEND</small></span></a><div className="lend-nav-links"><a href="/market">Market</a><a className="active" href="/lend">Lend</a><a href="/fx">FX</a><a href="/arcpay">Pay</a></div><div className="lend-wallet"><a href="/wallet">Wallet</a><button onClick={account ? disconnect : connect}>{short(account)}</button></div></nav>
    <header><p>ARC LEND · ARC MAINNET</p><h1>Supply USDC.<br/>Borrow against EURC.</h1><span>An isolated market on Arc Mainnet. Suppliers earn the interest borrowers pay; borrowers post Circle&apos;s EURC and take native USDC. Every rate, cap and price below is read live from the contract.</span><div className="lend-badges"><b>70% MAX LTV</b><b>80% LIQUIDATION</b><b>5% LIQUIDATION BONUS</b><b>10% OF INTEREST TO RESERVE</b></div></header>
    <section className="lend-terminal">
      <div className="lend-overview lend-totals"><article><small>TOTAL VALUE LOCKED</small><strong>{stats ? `$${fmt(String(stats.tvl))}` : "—"}</strong><em>deposits + EURC collateral</em></article><article><small>TOTAL DEPOSITS</small><strong>{stats ? `${fmt(String(stats.deposits))} USDC` : "—"}</strong><em>{stats ? `${fmt(String(stats.suppliedAllTime))} USDC supplied all-time` : ""}</em></article><article><small>TOTAL BORROWED</small><strong>{stats ? `${fmt(String(stats.borrowed))} USDC` : "—"}</strong><em>{stats ? `${fmt(String(stats.borrowedAllTime))} USDC borrowed all-time` : ""}</em></article><article><small>COLLATERAL LOCKED</small><strong>{stats ? `${fmt(String(stats.collateralEurc))} EURC` : "—"}</strong><em>{stats ? `${stats.users} wallet${stats.users === 1 ? " has" : "s have"} used this market` : ""}</em></article></div>
      <div className="lend-overview"><article><small>AVAILABLE TO BORROW</small><strong>{fmt(position.liquidity)} USDC</strong></article><article><small>SUPPLY APR</small><strong className="up">{position.supplyApr}%</strong></article><article><small>BORROW APR</small><strong>{position.borrowApr}%</strong></article><article><small>UTILIZATION</small><strong>{position.utilization}%</strong></article></div>
      <div className="lend-overview"><article><small>EUR / USD (SYNCED)</small><strong>{position.eurUsd}</strong><em>{position.priceAge ? ageLabel : ""}</em></article><article><small>SUPPLY CAP</small><strong>{fmt(position.supplyCap, 0)} USDC</strong></article><article><small>BORROW CAP</small><strong>{fmt(position.borrowCap, 0)} USDC</strong></article><article><small>PRICE SOURCE</small><strong>Uniswap TWAP · Pyth check</strong></article></div>
      {!account ? <div className="lend-gate"><h2>Connect an EVM wallet</h2><p>MetaMask, Rabby, OKX, Bitget, Coinbase Wallet, or another injected EVM wallet on Arc Mainnet.</p><button onClick={connect}>Connect wallet</button></div> : <>
        {!onArc && <button className="lend-network" onClick={switchArc}>Switch to Arc Mainnet</button>}
        {(!position.oracleFresh || position.paused) && <div className="lend-alert">{position.paused ? "Market is paused. Risk-increasing actions are unavailable." : <>The synced EUR/USD price is older than the market allows, so borrowing is paused until someone syncs it. <button className="lend-inline" disabled={busy} onClick={syncPrice}>Sync price</button></>}</div>}
        <div className="lend-overview lend-position"><article><small>YOUR SUPPLY</small><strong>{fmt(position.supplied, 4)} USDC</strong></article><article><small>YOUR COLLATERAL</small><strong>{fmt(position.collateral, 4)} EURC</strong></article><article><small>YOUR DEBT</small><strong>{fmt(position.borrowed, 4)} USDC</strong></article><article><small>HEALTH FACTOR</small><strong className={position.health !== "∞" && Number(position.health) < 1.1 ? "down" : ""}>{position.health}</strong><em>liquidation below 1.00</em></article></div>
        <div className="lend-actions">
          <article><p>USDC</p><h2>Supply, borrow, repay</h2><label>Amount<input inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.00"/><b>USDC</b></label>
            <small>Wallet {fmt(position.walletUsdc, 4)} USDC · you can borrow up to {fmt(position.canBorrow, 4)} USDC</small>
            <div><button disabled={busy||!amount} onClick={()=>action("supply")}>Supply</button><button disabled={busy||!amount||!position.oracleFresh} onClick={()=>action("borrow")}>Borrow</button><button disabled={busy||!amount} onClick={()=>action("repay")}>Repay</button><button disabled={busy||Number(position.supplied) === 0} onClick={()=>action("withdraw")}>Withdraw all supply</button></div></article>
          <article><p>EURC COLLATERAL</p><h2>Manage collateral</h2><label>Amount<input inputMode="decimal" value={collateral} onChange={e=>setCollateral(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.00"/><b>EURC</b></label>
            <small>Wallet {fmt(position.walletEurc, 4)} EURC · deposited {fmt(position.collateral, 4)} EURC</small>
            <div><button disabled={busy||!collateral} onClick={()=>action("collateral")}>Approve + deposit</button><button disabled={busy||!collateral||(!position.oracleFresh && Number(position.borrowed) > 0)} onClick={()=>action("withdrawCollateral")}>Withdraw</button></div></article>
        </div>
      </>}
      {status && <p className="lend-status">{status}</p>}
    </section>
    <section className="lend-flow"><p>HOW IT WORKS</p><h2>Know the route before you sign.</h2><div><article><i>01</i><b>Supply USDC</b><span>Your USDC joins the pool and earns the interest borrowers pay, minus the 10% reserve. Withdraw any time liquidity is available.</span></article><article><i>02</i><b>Post EURC</b><span>Deposit Circle&apos;s EURC as collateral. It is valued at the synced EUR/USD price.</span></article><article><i>03</i><b>Borrow USDC</b><span>Borrow up to 70% of your collateral&apos;s value. Above 80% anyone can liquidate part of the position with a 5% bonus.</span></article></div></section>
    <section className="lend-assets"><p>COLLATERAL</p><h2>Approved collateral, not arbitrary tokens.</h2><span>Each collateral gets its own isolated market with its own price source and caps.</span><div>{OFFICIAL_ARC_ASSET_STATUS.map(asset=><article key={asset.symbol}><b>{asset.symbol}</b><strong className={asset.state.includes("Live")||asset.state.includes("Borrow")?"live":"pending"}>{asset.state}</strong><small>{asset.note}</small></article>)}</div><aside><b>Live market</b><span>{LEND_MARKETS[0].name} · borrow {LEND_MARKETS[0].borrowAsset} against {LEND_MARKETS[0].collateralSymbol}</span></aside></section>
    <section className="lend-risk"><p>RISK</p><h2>Read this before you supply or borrow.</h2><div><article><b>Not audited</b><span>The market contract is source-verified but has not had an external audit. Caps are kept small for that reason.</span></article><article><b>Price source</b><span>EUR/USD is a 30-minute Uniswap V3 average, cross-checked against Pyth when Pyth has a fresh report. If the two disagree the market keeps its last good price.</span></article><article><b>Liquidation</b><span>If EUR falls against USD your health factor drops. Below 1.00 part of your EURC can be sold to a liquidator at a 5% discount.</span></article></div></section>
    <footer><span>Arc Lend · Arc Mainnet · utilization-priced interest</span><a href={`${ARC_MAINNET.explorer}/address/${ARC_LEND_ADDRESS}?tab=contract`} target="_blank" rel="noreferrer">View verified contract →</a></footer>
  </main>;
}

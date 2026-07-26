import { useCallback, useEffect, useState } from "react";
import { BrowserProvider, Contract, JsonRpcProvider, formatEther, formatUnits, parseUnits } from "ethers";
import { ARC, ARC_LEND_ADDRESS, ARC_LEND_COLLATERAL_ADDRESS } from "../config";
import { LEND_MARKETS, OFFICIAL_ARC_ASSET_STATUS } from "../lendMarkets";
import "./LendApp.css";

type Props = { account: string; chainId: number | null; activeProvider: EthereumProvider | null; connect: () => void; disconnect: () => void };
type Position = { supplied: string; collateral: string; borrowed: string; health: string; liquidity: string; supplyCap: string; borrowCap: string; paused: boolean; oracleFresh: boolean; utilization: string; borrowApr: string; supplyApr: string };

const MARKET_ABI = [
  "function supply() payable returns(uint256)", "function withdraw(uint256) returns(uint256)",
  "function depositCollateral(uint256)", "function withdrawCollateral(uint256)", "function borrow(uint256)",
  "function repay(address) payable", "function supplyShares(address) view returns(uint256)",
  "function collateralOf(address) view returns(uint256)", "function debtOf(address) view returns(uint256)",
  "function healthFactor(address) view returns(uint256)", "function totalAssets() view returns(uint256)",
  "function totalSupplyShares() view returns(uint256)", "function supplyCap() view returns(uint256)",
  "function borrowCap() view returns(uint256)", "function paused() view returns(bool)", "function oracle() view returns(address)",
  "function utilization() view returns(uint256)", "function borrowRatePerYear() view returns(uint256)", "function supplyRatePerYear() view returns(uint256)",
];
const TOKEN_ABI = ["function approve(address,uint256) returns(bool)", "function balanceOf(address) view returns(uint256)"];
const ORACLE_ABI = ["function price() view returns(uint256,uint64)"];
const empty: Position = { supplied: "0.00", collateral: "0.00", borrowed: "0.00", health: "—", liquidity: "0.00", supplyCap: "100", borrowCap: "50", paused: false, oracleFresh: false, utilization: "0.0", borrowApr: "0.0", supplyApr: "0.0" };
const short = (value: string) => value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "Connect wallet";

export default function LendApp({ account, chainId, activeProvider, connect, disconnect }: Props) {
  const [position, setPosition] = useState<Position>(empty);
  const [amount, setAmount] = useState("");
  const [collateral, setCollateral] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const onArc = chainId === ARC.id;

  const refresh = useCallback(async () => {
    if (!ARC_LEND_ADDRESS) return;
    try {
      // Arc's public RPC is most reliable in browsers with one JSON-RPC call per
      // request; disabling ethers batching also keeps CORS responses predictable.
      const provider = activeProvider ? new BrowserProvider(activeProvider) : new JsonRpcProvider(ARC.rpcs[1] || ARC.rpc, undefined, { batchMaxCount: 1 });
      const market = new Contract(ARC_LEND_ADDRESS, MARKET_ABI, provider);
      const [assets, totalShares, sCap, bCap, paused, oracleAddress, utilizationWad, borrowRateWad, supplyRateWad] = await Promise.all([
        market.totalAssets(), market.totalSupplyShares(), market.supplyCap(), market.borrowCap(), market.paused(), market.oracle(),
        market.utilization(), market.borrowRatePerYear(), market.supplyRatePerYear(),
      ]);
      const totalAssets = BigInt(assets); const shareTotal = BigInt(totalShares);
      let supplied = 0n, userCollateral = 0n, debt = 0n, health = 0n;
      if (account) {
        const shares = BigInt(await market.supplyShares(account));
        const [rawCollateral, rawDebt] = await Promise.all([market.collateralOf(account), market.debtOf(account)]);
        userCollateral = BigInt(rawCollateral); debt = BigInt(rawDebt);
        supplied = shareTotal === 0n ? 0n : shares * totalAssets / shareTotal;
        try { health = BigInt(await market.healthFactor(account)); } catch { health = 0n; }
      }
      const [, updatedAt] = await new Contract(oracleAddress, ORACLE_ABI, provider).price();
      const age = Math.floor(Date.now() / 1000) - Number(updatedAt);
      setPosition({ supplied: formatEther(supplied), collateral: formatUnits(userCollateral, 6), borrowed: formatEther(debt), health: debt === 0n ? "∞" : Number(formatEther(health)).toFixed(2), liquidity: formatEther(await provider.getBalance(ARC_LEND_ADDRESS)), supplyCap: formatEther(sCap), borrowCap: formatEther(bCap), paused, oracleFresh: age >= 0 && age <= 3600, utilization: (Number(formatEther(utilizationWad)) * 100).toFixed(1), borrowApr: (Number(formatEther(borrowRateWad)) * 100).toFixed(2), supplyApr: (Number(formatEther(supplyRateWad)) * 100).toFixed(2) });
    } catch { if (account) setStatus("Connected, but the Arc RPC could not refresh this position yet. Transactions remain wallet-confirmed."); }
  }, [account, activeProvider]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function switchArc() {
    if (!activeProvider) return connect();
    try { await activeProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ARC.hexId }] }); }
    catch (error) {
      const code = typeof error === "object" && error && "code" in error ? Number((error as { code?: unknown }).code) : 0;
      if (code !== 4902) return setStatus(error instanceof Error ? error.message : "Could not switch to Arc");
      await activeProvider.request({ method: "wallet_addEthereumChain", params: [{ chainId: ARC.hexId, chainName: ARC.name, nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: [ARC.rpc], blockExplorerUrls: [ARC.explorer] }] });
    }
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
    } catch (error) { setStatus(error instanceof Error ? error.message : "Transaction failed"); }
    finally { setBusy(false); }
  }

  return <main className="lend-site">
    <nav><a href="https://arcodian.fun" className="lend-brand"><img src="/arcodian-mark.svg" alt=""/><span>ARCODIAN<small>ARC LEND</small></span></a><div className="lend-nav-links"><a href="https://arcodian.fun/swap">Product</a><a className="active" href="https://lend.arcodian.fun">Market</a><a href="https://arcodian.fun/arcpay">Pay</a><a href="https://arcodian.fun/agentpay">Agent</a></div><div className="lend-wallet"><a href="https://wallet.arcodian.fun">Wallet</a><button onClick={account ? disconnect : connect}>{short(account)}</button></div></nav>
    <header><p>ARC LEND · ARC TESTNET</p><h1>Supply USDC.<br/>Borrow USDC.</h1><span>Use approved Arc assets as collateral in isolated markets. The first live market accepts EURC collateral; it does not lend EURC.</span><div className="lend-badges"><b>70% MAX LTV</b><b>80% LIQUIDATION</b><b>10% INTEREST RESERVE</b></div></header>
    <section className="lend-terminal">
      <div className="lend-overview"><article><small>MARKET LIQUIDITY</small><strong>{Number(position.liquidity).toFixed(2)} USDC</strong></article><article><small>YOUR SUPPLY</small><strong>{Number(position.supplied).toFixed(4)} USDC</strong></article><article><small>YOUR DEBT</small><strong>{Number(position.borrowed).toFixed(4)} USDC</strong></article><article><small>HEALTH FACTOR</small><strong>{position.health}</strong></article></div>
      <div className="lend-overview"><article><small>UTILIZATION</small><strong>{position.utilization}%</strong></article><article><small>BORROW APR</small><strong>{position.borrowApr}%</strong></article><article><small>SUPPLY APR</small><strong>{position.supplyApr}%</strong></article><article><small>RATE MODEL</small><strong>Utilization curve</strong></article></div>
      {!account ? <div className="lend-gate"><h2>Connect an EVM wallet</h2><p>MetaMask, Rabby, OKX, Bitget, Coinbase Wallet, or another injected EVM wallet.</p><button onClick={connect}>Connect wallet</button></div> : <>
        {!onArc && <button className="lend-network" onClick={switchArc}>Switch to Arc Testnet</button>}
        {(!position.oracleFresh || position.paused) && <div className="lend-alert">{position.paused ? "Market is paused. Risk-increasing actions are unavailable." : "Oracle update is stale. New borrowing and collateral-sensitive actions will fail closed until refreshed."}</div>}
        <div className="lend-actions">
          <article><p>BORROW ASSET · USDC</p><h2>Supply & borrow USDC</h2><label>Amount<input inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="0.00"/><b>USDC</b></label><div><button disabled={busy||!amount} onClick={()=>action("supply")}>Supply USDC</button><button disabled={busy||!amount} onClick={()=>action("borrow")}>Borrow USDC</button><button disabled={busy||!amount} onClick={()=>action("repay")}>Repay USDC</button><button disabled={busy} onClick={()=>action("withdraw")}>Withdraw supply</button></div></article>
          <article><p>EURC COLLATERAL</p><h2>Manage collateral</h2><label>Amount<input inputMode="decimal" value={collateral} onChange={e=>setCollateral(e.target.value)} placeholder="0.00"/><b>EURC</b></label><div><button disabled={busy||!collateral} onClick={()=>action("collateral")}>Approve + deposit</button><button disabled={busy||!collateral} onClick={()=>action("withdrawCollateral")}>Withdraw</button></div><small>Deposited: {Number(position.collateral).toFixed(4)} EURC</small></article>
        </div>
      </>}
      {status && <p className="lend-status">{status}</p>}
    </section>
    <section className="lend-assets"><p>SUPPORTED ARC ASSETS</p><h2>Approved collateral, not arbitrary tokens.</h2><span>Every new collateral requires a canonical token contract, independent oracle, liquidity review, immutable caps, and its own isolated market.</span><div>{OFFICIAL_ARC_ASSET_STATUS.map(asset=><article key={asset.symbol}><b>{asset.symbol}</b><strong className={asset.state.includes("Live")||asset.state.includes("Borrow")?"live":"pending"}>{asset.state}</strong><small>{asset.note}</small></article>)}</div><aside><b>Live market</b><span>{LEND_MARKETS[0].name} · borrow {LEND_MARKETS[0].borrowAsset} against {LEND_MARKETS[0].collateralSymbol}</span></aside></section>
    <section className="lend-flow"><p>ONE ISOLATED MARKET</p><h2>Know the route before you sign.</h2><div><article><i>01</i><b>Supply</b><span>Deposit USDC to earn from borrower interest inside this market.</span></article><article><i>02</i><b>Collateralize</b><span>Approve official EURC, then deposit it under visible caps and oracle rules.</span></article><article><i>03</i><b>Borrow safely</b><span>Borrow USDC while monitoring health factor and liquidation threshold.</span></article></div></section>
    <section className="lend-risk"><p>CANARY PARAMETERS</p><h2>Risk is visible before you sign.</h2><div><article><b>{Number(position.supplyCap).toLocaleString()} USDC</b><span>Immutable supply cap</span></article><article><b>{Number(position.borrowCap).toLocaleString()} USDC</b><span>Immutable borrow cap</span></article><article><b>EURC</b><span>Official Arc collateral · 6 decimals</span></article></div></section>
    <footer><span>Testnet canary · Utilization-priced interest · Not audited for production funds</span><a href={`https://testnet.arcscan.app/address/${ARC_LEND_ADDRESS}`} target="_blank" rel="noreferrer">View contract →</a></footer>
  </main>;
}

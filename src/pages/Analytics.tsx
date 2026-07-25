import { useEffect, useState } from "react";
import { ARC } from "../config";
import "./Analytics.css";

type Data = any;
const money=(v:unknown)=>`$${Number(v||0).toLocaleString(undefined,{maximumFractionDigits:4})}`;
export default function Analytics(){
 const [data,setData]=useState<Data|null>(null); const [monitor,setMonitor]=useState<Data|null>(null); const [error,setError]=useState("");
 useEffect(()=>{fetch("/data/analytics.json",{cache:"no-store"}).then(r=>{if(!r.ok)throw Error("Analytics feed unavailable");return r.json()}).then(setData).catch(e=>setError(e.message));fetch("/data/notifications.json",{cache:"no-store"}).then(r=>r.ok?r.json():null).then(setMonitor).catch(()=>{})},[]);
 if(!data)return <section className="analytics"><p>{error||"Loading verified onchain metrics…"}</p></section>;
 const age=Math.max(0,Math.floor((Date.now()-Date.parse(data.indexedAt))/60000));
 return <section className="analytics">
  <header><p>UNIFIED PUBLIC ANALYTICS · ARC TESTNET</p><h1>One public ledger.<br/>No invented numbers.</h1><span>Every metric below comes from finalized events, contract state, Circle attestations, or destination-chain nonces.</span><div><b>{age<5?"LIVE":"STALE"}</b><small>Indexed {age} min ago · block {Number(data.indexedBlock).toLocaleString()}</small></div></header>
  {monitor&&<aside className={`analytics-monitor ${monitor.status}`}><div><p>UNIFIED MONITOR</p><b>{monitor.status==="healthy"?"All monitored systems healthy":`${monitor.counts.critical} critical · ${monitor.counts.warning} warning`}</b><small>Oracle, keeper, bridge, Agent Pay, treasury, and indexer freshness · {new Date(monitor.generatedAt).toLocaleString()}</small></div>{monitor.alerts?.slice(0,3).map((alert:Data)=><a key={alert.id} href={alert.href||"/analytics"}>{alert.title} →</a>)}</aside>}
  <div className="analytics-grid">
   <article><p>ARC PAY</p><h2>{money(data.arcpay.grossVolumeUsd)}</h2><span>Gross payment volume</span><dl><div><dt>Payments</dt><dd>{data.arcpay.payments||0}</dd></div><div><dt>Refunds</dt><dd>{data.arcpay.refunds||0}</dd></div><div><dt>Protocol fees</dt><dd>{money(data.arcpay.protocolFeesUsd)}</dd></div></dl><a href="/arcpay">Open Arc Pay →</a></article>
   <article><p>BRIDGE · CCTP</p><h2>{money(data.bridge.volumeUsd)}</h2><span>Successful Arc-origin burn calls</span><dl><div><dt>Burns</dt><dd>{data.bridge.burns}</dd></div><div><dt>Completed verified</dt><dd>{data.bridge.completionChecked?data.bridge.completed:"—"}</dd></div><div><dt>Completion coverage</dt><dd>{data.bridge.completionChecked}/{data.bridge.burns}</dd></div></dl><a href="https://bridge.arcodian.fun/">Open bridge →</a></article>
   <article><p>STABLECOIN FX</p><h2>{money(data.fx.tvlUsd)}</h2><span>USDC + EURC TVL</span><dl><div><dt>Swaps</dt><dd>{data.fx.swaps||0}</dd></div><div><dt>Volume</dt><dd>{money(data.fx.volumeUsd)}</dd></div><div><dt>Protocol fees</dt><dd>{money(data.fx.protocolFeesUsd)}</dd></div></dl><a href="/fx">Open FX →</a></article>
   <article><p>MARKET + DEX</p><h2>{money(data.market.volumeUsd)}</h2><span>Indexed curve and DEX volume</span><dl><div><dt>Launches</dt><dd>{data.market.launches}</dd></div><div><dt>Trades</dt><dd>{data.market.trades}</dd></div><div><dt>Holders</dt><dd>{data.market.holders}</dd></div></dl><a href="https://market.arcodian.fun/">Open market →</a></article>
   <article><p>ARC LEND</p><h2>{money(data.lend.suppliedUsd)}</h2><span>Total supplied assets</span><dl><div><dt>Borrowed</dt><dd>{money(data.lend.borrowedUsd)}</dd></div><div><dt>Utilization</dt><dd>{Number(data.lend.utilizationPct).toFixed(2)}%</dd></div><div><dt>Reserve revenue</dt><dd>{money(data.lend.reserveRevenueUsd)}</dd></div></dl><a href="https://lend.arcodian.fun/">Open Lend →</a></article>
   <article className="revenue"><p>VERIFIED REVENUE</p><h2>{money(Number(data.revenue.arcpayUsd)+Number(data.revenue.fxUsd)+Number(data.revenue.lendUsd))}</h2><span>Arc Pay + FX + lending reserve</span><dl><div><dt>Arc Pay</dt><dd>{money(data.revenue.arcpayUsd)}</dd></div><div><dt>FX</dt><dd>{money(data.revenue.fxUsd)}</dd></div><div><dt>Lend</dt><dd>{money(data.revenue.lendUsd)}</dd></div></dl><small>{data.revenue.note}</small></article>
  </div>
  <footer><span>Sources: Arc RPC, Arcscan, Circle Iris, destination MessageTransmitter.</span><a href={`${ARC.explorer}/block/${data.indexedBlock}`} target="_blank" rel="noreferrer">Verify indexed block ↗</a></footer>
 </section>
}

import {useCallback,useEffect,useState} from "react";
import {BrowserProvider,Contract,JsonRpcProvider,formatEther} from "ethers";
import {PAY_VAULT_ADDRESS,PAY_VAULT_ABI,ARC} from "../config";
import {fetchServicesFeed,pinServiceMetadata,registerService,deposit,type FeedService} from "../lib/agentServices";
import {describeTxError} from "../txError";
import "./AgentPay.css";
import "./Services.css";

type Props={account:string;chainId:number|null;activeProvider:EthereumProvider|null;connect:()=>void};
type View="board"|"register";
const short=(x:string)=>x?`${x.slice(0,6)}…${x.slice(-4)}`:"—";
function metaName(m:string):{name:string;model:string}{
  try{const o=JSON.parse(m);return {name:o.name||"Service",model:o.model||"—"};}catch{return {name:"Service",model:"—"};}
}

export default function Services({account,chainId,activeProvider,connect}:Props){
  const [view,setView]=useState<View>("board");
  const [feed,setFeed]=useState<FeedService[]>([]);
  const [feedLoading,setFeedLoading]=useState(true);
  const [credits,setCredits]=useState<string>("0");
  const [topup,setTopup]=useState("0.1");
  const [status,setStatus]=useState("");const [busy,setBusy]=useState(false);
  // register form
  const [rName,setRName]=useState("");const [rDesc,setRDesc]=useState("");const [rPrice,setRPrice]=useState("0.01");const [rEndpoint,setREndpoint]=useState("");

  const refresh=useCallback(async()=>{try{setFeed(await fetchServicesFeed());}finally{setFeedLoading(false);}},[]);
  useEffect(()=>{void refresh();},[refresh,status]);
  const loadCredits=useCallback(async()=>{
    if(!account)return;
    try{const p=new JsonRpcProvider(ARC.rpc,undefined,{batchMaxCount:1});const bal=await new Contract(PAY_VAULT_ADDRESS,PAY_VAULT_ABI,p).freeBalance(account);p.destroy();setCredits(formatEther(bal));}catch{/* ignore */}
  },[account]);
  useEffect(()=>{void loadCredits();},[loadCredits,status]);

  async function signer(){if(!activeProvider){connect();throw new Error("Connect wallet first");}if(chainId!==ARC.id){await activeProvider.request({method:"wallet_switchEthereumChain",params:[{chainId:ARC.hexId}]});throw new Error("Network switched. Review and submit again.");}return new BrowserProvider(activeProvider).getSigner();}

  async function topUp(){
    setBusy(true);setStatus("Top up: waiting for wallet…");
    try{const s=await signer();const tx=await deposit(s,topup);setStatus(`Top up submitted ${short(tx.hash)}…`);await tx.wait();setStatus(`Credited ${topup} USDC`);await loadCredits();}
    catch(e){setStatus(describeTxError(e));}finally{setBusy(false);}
  }
  async function register(){
    if(!rName||!rPrice||!rEndpoint){setStatus("Name, price and endpoint are required");return;}
    setBusy(true);setStatus("Pinning service metadata…");
    try{
      const {url}=await pinServiceMetadata({name:rName,description:rDesc,model:"Arcodian-3",priceUSDC:rPrice});
      const s=await signer();
      setStatus(`Metadata pinned. Registering service…`);
      const tx=await registerService(s,rPrice,rEndpoint,url);
      setStatus(`Registration submitted ${short(tx.hash)}…`);await tx.wait();
      setStatus(`Service registered · ${rName}`);setView("board");await refresh();
    }catch(e){const msg=describeTxError(e);setStatus(/NoAgentId|agentId|0x[0-9a-f]*/.test(msg)&&/revert|NoAgent/i.test(msg)?"Your wallet has no agent identity yet — register & bind one at /agents first, then register a service.":msg);}
    finally{setBusy(false);}
  }

  return <main className="agent-pay services-page">
    <header><p>AGENTRAIL · PAY-PER-CALL SERVICES</p><h1>Prepaid credits.<br/>Pay per call.</h1><span>Top up USDC once, then pay agents per call with off-chain signed vouchers — instant, near-zero cost per call. Providers redeem on-chain whenever; a flat 0.5% protocol fee applies at redemption. Non-custodial: your credits only ever move to a provider against a voucher you signed.</span><div><b>LIVE · ARC TESTNET</b><a href={`${ARC.explorer}/address/${PAY_VAULT_ADDRESS}`} target="_blank" rel="noreferrer">{short(PAY_VAULT_ADDRESS)} ↗</a></div></header>

    <section className="services-overview" aria-label="AgentRail overview">
      <article><small>SERVICES</small><strong>{feed.length}</strong><span>Registered on-chain</span></article>
      <article><small>YOUR CREDITS</small><strong>{Number(credits).toLocaleString(undefined,{maximumFractionDigits:4})} USDC</strong><span>Deposited, spendable</span></article>
      <article><small>PROTOCOL FEE</small><strong>0.5%</strong><span>Taken at redemption</span></article>
      <article><small>PER-CALL COST</small><strong>~0 gas</strong><span>Off-chain vouchers</span></article>
    </section>
    <section className="services-flow" aria-label="Voucher flow"><span><i>01</i><b>Top up</b><small>Deposit USDC once</small></span><span><i>02</i><b>Allocate</b><small>Reserve to a provider</small></span><span><i>03</i><b>Call</b><small>Sign a voucher/call</small></span><span><i>04</i><b>Redeem</b><small>Provider settles on-chain</small></span></section>

    <section className="services-form" aria-label="Your credits"><p>CREDITS · TOP UP</p><h2>Fund your balance</h2>
      <span>Balance: <b>{Number(credits).toLocaleString(undefined,{maximumFractionDigits:4})} USDC</b>. Deposits are non-custodial — withdraw any unallocated amount anytime.</span>
      {!account?<button className="agent-connect" onClick={connect}>Connect wallet to top up</button>:
        <div className="agent-row"><label>Amount (USDC)<input value={topup} onChange={e=>setTopup(e.target.value)} placeholder="0.1"/></label><button disabled={busy||!topup} onClick={()=>void topUp()}>Top up {topup||"0"} USDC</button></div>}
    </section>

    <nav className="services-tabs" aria-label="Services views">
      {(["board","register"] as View[]).map(v=><button key={v} className={view===v?"active":""} onClick={()=>setView(v)}>{v==="board"?"Service directory":"Register a service"}</button>)}
    </nav>

    {view==="board"&&<section className="services-board">
      {feedLoading?<p className="services-empty">Loading services…</p>:feed.length===0?<p className="services-empty">No services registered yet. Register the first one.</p>:
        <div className="services-table" role="table">
          <div className="services-row services-head" role="row"><span>Service</span><span>Model</span><span>Price/call</span><span>Provider</span><span>Volume</span><span>Rep</span></div>
          {feed.map(s=>{const m=metaName(s.metadataURI);return <a key={s.serviceId} className="services-row" role="row" href={`/service/${s.serviceId}`}>
            <span>{m.name}{!s.active&&<i className="services-chip st-rejected"> inactive</i>}</span>
            <span>{m.model}</span>
            <span>{s.price} USDC</span>
            <span>{short(s.provider)}</span>
            <span>{Number(s.volume).toLocaleString(undefined,{maximumFractionDigits:4})} USDC</span>
            <span>{s.reputation>0?<i className="services-rep" title={`Reputation ${s.reputation}/100`}>★ {s.reputation}</i>:"—"}</span>
          </a>;})}
        </div>}
    </section>}

    {view==="register"&&(!account?<button className="agent-connect" onClick={connect}>Connect wallet to register a service</button>:
      <section className="services-form"><p>PROVIDER · REGISTER</p><h2>List a pay-per-call service</h2>
        <span>Your wallet must have an ERC-8004 agent identity bound (register one at <a href="/agents">/agents</a>). The price is charged per call; buyers pay via signed vouchers you redeem on-chain.</span>
        <label>Service name<input value={rName} onChange={e=>setRName(e.target.value)} placeholder="Arcodian-3 inference"/></label>
        <label>Description<input value={rDesc} onChange={e=>setRDesc(e.target.value)} placeholder="One-shot LLM inference"/></label>
        <div className="agent-row"><label>Price per call (USDC)<input value={rPrice} onChange={e=>setRPrice(e.target.value)} placeholder="0.01"/></label><label>Endpoint URL<input value={rEndpoint} onChange={e=>setREndpoint(e.target.value)} placeholder="https://your-agent/serve"/></label></div>
        <button disabled={busy||!rName||!rPrice||!rEndpoint} onClick={()=>void register()}>Register service</button>
      </section>)}

    {status&&<p className="agent-status">{status}</p>}
    <footer><span>Settlement via ArcPayVault ({short(PAY_VAULT_ADDRESS)}) · 0.5% fee at redemption.</span><span><a href="/agents">Browse agents →</a> · <a href="/jobs">Agent Jobs →</a></span></footer>
  </main>;
}

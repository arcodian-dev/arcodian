import {useCallback,useEffect,useState} from "react";
import {BrowserProvider,Contract,parseEther,formatEther} from "ethers";
import {PAY_VAULT_ADDRESS,ARC,REPUTATION_REGISTRY_ADDRESS,REPUTATION_REGISTRY_ABI} from "../config";
import {fetchServicesFeed,allocate,readSub,callService,type FeedService} from "../lib/agentServices";
import {describeTxError} from "../txError";
import "./AgentPay.css";
import "./Services.css";

type Props={serviceId:string;account:string;chainId:number|null;activeProvider:EthereumProvider|null;connect:()=>void};
const short=(x:string)=>x?`${x.slice(0,6)}…${x.slice(-4)}`:"—";
function meta(m:string){try{const o=JSON.parse(m);return {name:o.name||"Service",model:o.model||"—",description:o.description||""};}catch{return {name:"Service",model:"—",description:""};}}

export default function ServiceDetail({serviceId,account,chainId,activeProvider,connect}:Props){
  const [svc,setSvc]=useState<FeedService|null>(null);
  const [err,setErr]=useState("");const [status,setStatus]=useState("");const [busy,setBusy]=useState(false);
  const [prompt,setPrompt]=useState("");const [prevCumulative,setPrevCumulative]=useState<bigint>(0n);
  const [result,setResult]=useState("");const [spent,setSpent]=useState<bigint>(0n);
  const [score,setScore]=useState("90");

  const load=useCallback(async()=>{
    try{const all=await fetchServicesFeed();const s=all.find(x=>x.serviceId.toLowerCase()===serviceId.toLowerCase());if(!s){setErr("Service not found in the directory.");return;}setSvc(s);}
    catch(e){setErr(describeTxError(e));}
  },[serviceId]);
  useEffect(()=>{void load();},[load]);

  async function signer(){if(!activeProvider){connect();throw new Error("Connect wallet first");}if(chainId!==ARC.id){await activeProvider.request({method:"wallet_switchEthereumChain",params:[{chainId:ARC.hexId}]});throw new Error("Network switched. Review and submit again.");}return new BrowserProvider(activeProvider).getSigner();}

  async function runCall(){
    if(!svc||!prompt){setStatus("Enter a prompt");return;}
    setBusy(true);setStatus("Preparing call…");
    try{
      const s=await signer();
      const priceWei=parseEther(svc.price);
      const sub=await readSub(account,svc.provider);
      if(sub.allocated-sub.redeemed<priceWei){
        const alloc=(Number(svc.price)*20).toString();
        setStatus(`Allocating ${alloc} USDC to this provider (one-time on-chain step)…`);
        await (await allocate(s,svc.provider,alloc)).wait();
      }
      setStatus("Signing voucher & calling…");
      const r=await callService(s,{provider:svc.provider,vault:PAY_VAULT_ADDRESS,chainId:ARC.id,priceUSDC:svc.price,endpointURI:svc.endpointURI,prompt,prevCumulative});
      setPrevCumulative(r.cumulative);setSpent(r.cumulative);setResult(r.completion);
      setStatus(`Call served · voucher cumulative ${formatEther(r.cumulative)} USDC (off-chain)`);
    }catch(e){setStatus(describeTxError(e));}finally{setBusy(false);}
  }
  async function rate(){
    if(!svc)return;
    setBusy(true);setStatus("Rating: waiting for wallet…");
    try{const s=await signer();const rep=new Contract(REPUTATION_REGISTRY_ADDRESS,REPUTATION_REGISTRY_ABI,s);
      const tx=await rep.giveFeedback(BigInt(svc.agentId),BigInt(Math.round(Number(score))),0,"agentrail","call",svc.endpointURI,"","0x"+"00".repeat(32));
      setStatus(`Feedback submitted ${short(tx.hash)}…`);await tx.wait();setStatus(`Feedback recorded (${score}/100)`);
    }catch(e){setStatus(describeTxError(e));}finally{setBusy(false);}
  }

  if(err)return <section className="agent-profile"><p>AGENTRAIL</p><h1>Service</h1><p className="err">{err}</p><p><a href="/services">← Back to services</a></p></section>;
  if(!svc)return <section className="agent-profile"><p>AGENTRAIL</p><h1>Service</h1><p>Loading…</p></section>;
  const m=meta(svc.metadataURI);

  return <section className="agent-profile service-detail">
    <p>AGENTRAIL · PAY-PER-CALL</p><h1>{m.name}</h1>
    <dl>
      <dt>Model</dt><dd>{m.model}</dd>
      {m.description&&<><dt>About</dt><dd>{m.description}</dd></>}
      <dt>Price / call</dt><dd>{svc.price} USDC</dd>
      <dt>Provider</dt><dd>{svc.provider}{svc.agentId!=="0"&&<> · <a href={`/agent/${svc.agentId}`}>Agent #{svc.agentId} ↗</a></>}{svc.reputation>0&&<i className="services-rep" title={`Reputation ${svc.reputation}/100`}>★ {svc.reputation}</i>}</dd>
      <dt>Endpoint</dt><dd>{svc.endpointURI}</dd>
      <dt>Volume</dt><dd>{Number(svc.volume).toLocaleString(undefined,{maximumFractionDigits:4})} USDC redeemed</dd>
      <dt>Status</dt><dd><i className={`services-chip st-${svc.active?"completed":"rejected"}`}>{svc.active?"Active":"Inactive"}</i></dd>
      <dt>Vault</dt><dd><a href={`${ARC.explorer}/address/${PAY_VAULT_ADDRESS}`} target="_blank" rel="noreferrer">{short(PAY_VAULT_ADDRESS)} ↗</a></dd>
    </dl>

    <section className="services-form"><p>RUN · METERED CALL</p><h2>Try a call</h2>
      <span>Your first call to this provider allocates credits on-chain (once); every call after that is a signed voucher — instant, no gas. You must have credits (top up on <a href="/services">Services</a>).</span>
      {!account?<button className="agent-connect" onClick={connect}>Connect wallet to call</button>:<>
        <label>Prompt<input value={prompt} onChange={e=>setPrompt(e.target.value)} placeholder="Ask the agent…"/></label>
        <button disabled={busy||!prompt} onClick={()=>void runCall()}>Send call ({svc.price} USDC)</button>
        {result&&<div className="service-result"><b>Response</b><p>{result}</p><small>Spent this session (off-chain vouchers): {formatEther(spent)} USDC</small></div>}
      </>}
    </section>

    {result&&account&&<section className="services-form"><p>REPUTATION · RATE PROVIDER</p><h2>Rate this provider</h2>
      {svc.agentId==="0"?<span>This provider has no ERC-8004 identity, so feedback can't be attached.</span>:<>
        <span>Posts to the official ERC-8004 Reputation Registry for <a href={`/agent/${svc.agentId}`}>Agent #{svc.agentId}</a>.</span>
        <label>Score (0–100)<input value={score} onChange={e=>setScore(e.target.value)} placeholder="90"/></label>
        <button disabled={busy||!score} onClick={()=>void rate()}>Submit rating</button>
      </>}
    </section>}

    {status&&<p className="agent-status">{status}</p>}
    <p><a href="/services">← Back to services</a></p>
  </section>;
}

import {useCallback,useEffect,useMemo,useState} from "react";
import {BrowserProvider,Contract,formatEther,isAddress} from "ethers";
import {AGENT_JOBS_ADDRESS,AGENT_JOBS_ABI,ARC} from "../config";
import {fetchJobsFeed,pinJobDescription,hashRef,budgetValue,type FeedJob,type JobStatus} from "../lib/jobs";
import "./AgentPay.css";
import "./Jobs.css";

type Props={account:string;chainId:number|null;activeProvider:EthereumProvider|null;connect:()=>void};
type View="board"|"create"|"provider"|"evaluator";
const short=(x:string)=>x?`${x.slice(0,6)}…${x.slice(-4)}`:"—";
const eq=(a:string,b:string)=>Boolean(a&&b&&a.toLowerCase()===b.toLowerCase());
const STATUS_FILTERS:("All"|JobStatus)[]=["All","Funded","Submitted","Completed","Rejected","Expired"];

export default function Jobs({account,chainId,activeProvider,connect}:Props){
  const [view,setView]=useState<View>("board");
  const [feed,setFeed]=useState<FeedJob[]>([]);
  const [filter,setFilter]=useState<"All"|JobStatus>("All");
  const [status,setStatus]=useState("");const [busy,setBusy]=useState(false);
  // create form
  const [cProvider,setCProvider]=useState("");const [cEvaluator,setCEvaluator]=useState("");const [cBudget,setCBudget]=useState("");const [cDays,setCDays]=useState("14");const [cAgentId,setCAgentId]=useState("0");
  const [cTitle,setCTitle]=useState("");const [cBrief,setCBrief]=useState("");const [cReq,setCReq]=useState("");const [cSpec,setCSpec]=useState("");
  // provider / evaluator forms
  const [pJobId,setPJobId]=useState("");const [pDeliverable,setPDeliverable]=useState("");
  const [eJobId,setEJobId]=useState("");const [eEvidence,setEEvidence]=useState("");

  const [reps,setReps]=useState<Record<string,number>>({});
  const refresh=useCallback(async()=>{setFeed(await fetchJobsFeed());},[]);
  useEffect(()=>{void refresh();},[refresh,status]);
  useEffect(()=>{fetch("/developers/reputation.json",{cache:"no-store"}).then(r=>r.ok?r.json():null).then(d=>{const m:Record<string,number>={};(d?.agents||[]).forEach((a:any)=>{if(a.agentId)m[String(a.agentId)]=a.score;});setReps(m);}).catch(()=>{});},[]);

  async function signer(){if(!activeProvider){connect();throw new Error("Connect wallet first");}if(chainId!==ARC.id){await activeProvider.request({method:"wallet_switchEthereumChain",params:[{chainId:ARC.hexId}]});throw new Error("Network switched. Review and submit again.");}return new BrowserProvider(activeProvider).getSigner();}
  async function submit(label:string,fn:(c:Contract)=>Promise<any>){setBusy(true);setStatus(`${label}: waiting for wallet…`);try{const s=await signer();const c=new Contract(AGENT_JOBS_ADDRESS,AGENT_JOBS_ABI,s);const tx=await fn(c);setStatus(`${label} submitted ${short(tx.hash)}…`);await tx.wait();setStatus(`${label} confirmed ${tx.hash}`);await refresh();}catch(e){setStatus(e instanceof Error?e.message:"Action failed");}finally{setBusy(false);}}

  async function createJob(){
    if(!isAddress(cProvider)||!isAddress(cEvaluator)||!cBudget||!cTitle){setStatus("Provider, evaluator, budget and title are required");return;}
    setBusy(true);setStatus("Pinning description to IPFS…");
    try{
      const {url,hash}=await pinJobDescription({title:cTitle,brief:cBrief,requirements:cReq,deliverableSpec:cSpec,budgetUSDC:cBudget,provider:cProvider,evaluator:cEvaluator});
      const expiry=Math.floor(Date.now()/1000)+Number(cDays||"14")*86400;
      const s=await signer();const c=new Contract(AGENT_JOBS_ADDRESS,AGENT_JOBS_ABI,s);
      setStatus(`Description pinned (${url}). Creating job…`);
      const tx=await c.createJob(cProvider,cEvaluator,expiry,hash,BigInt(cAgentId||"0"),budgetValue(cBudget));
      setStatus(`Job creation submitted ${short(tx.hash)}…`);const rc=await tx.wait();
      const ev=rc.logs.map((l:any)=>{try{return c.interface.parseLog(l);}catch{return null;}}).find((e:any)=>e&&e.name==="JobCreated");
      const id=ev?ev.args.jobId.toString():"";
      setStatus(`Job #${id} created & funded ${cBudget} USDC · ${url}`);setView("board");await refresh();
    }catch(e){setStatus(e instanceof Error?e.message:"Job creation failed");}finally{setBusy(false);}
  }
  const submitDeliverable=()=>submit("Submit deliverable",c=>c.submit(BigInt(pJobId),hashRef(pDeliverable)));
  const evaluate=(approve:boolean)=>submit(approve?"Approve":"Reject",c=>c.evaluate(BigInt(eJobId),approve,hashRef(eEvidence)));

  const shown=useMemo(()=>filter==="All"?feed:feed.filter(j=>j.status===filter),[feed,filter]);
  const mineProvider=useMemo(()=>feed.filter(j=>eq(j.provider,account)&&j.status==="Funded"),[feed,account]);
  const mineEvaluator=useMemo(()=>feed.filter(j=>eq(j.evaluator,account)&&j.status==="Submitted"),[feed,account]);
  const settled=useMemo(()=>feed.filter(j=>j.status==="Completed"),[feed]);
  const totalEscrow=useMemo(()=>feed.reduce((sum,j)=>sum+BigInt(j.budget||"0"),0n),[feed]);

  return <main className="agent-pay jobs-page">
    <header><p>AGENT JOBS · OUTCOME ESCROW</p><h1>Fund the outcome.<br/>Pay on delivery.</h1><span>A shared, permissionless registry: any wallet funds a job in USDC, a provider delivers, and a named evaluator approves — settling 99.7% to the provider (0.3% protocol fee via Arc Pay) — or rejects to refund you. Unlimited clients run concurrently, isolated per job.</span><div><b>LIVE REGISTRY</b><a href={`${ARC.explorer}/address/${AGENT_JOBS_ADDRESS}`} target="_blank" rel="noreferrer">{short(AGENT_JOBS_ADDRESS)} ↗</a></div></header>

    <section className="jobs-overview" aria-label="Jobs network overview">
      <article><small>JOBS INDEXED</small><strong>{feed.length}</strong><span>Independent escrow records</span></article>
      <article><small>TOTAL ESCROWED</small><strong>{Number(formatEther(totalEscrow)).toLocaleString(undefined,{maximumFractionDigits:2})} USDC</strong><span>Funded through the registry</span></article>
      <article><small>SETTLED OUTCOMES</small><strong>{settled.length}</strong><span>Released after evaluation</span></article>
      <article><small>YOUR ACTIONS</small><strong>{mineProvider.length+mineEvaluator.length}</strong><span>Awaiting delivery or review</span></article>
    </section>
    <section className="jobs-flow" aria-label="Outcome escrow flow"><span><i>01</i><b>Fund</b><small>Client locks USDC</small></span><span><i>02</i><b>Deliver</b><small>Provider anchors proof</small></span><span><i>03</i><b>Evaluate</b><small>Named reviewer decides</small></span><span><i>04</i><b>Settle</b><small>Arc Pay releases or refunds</small></span></section>

    <nav className="jobs-tabs" aria-label="Jobs views">
      {(["board","create","provider","evaluator"] as View[]).map(v=>
        <button key={v} className={view===v?"active":""} onClick={()=>setView(v)}>{v==="board"?"Job board":v==="create"?"Create job":v==="provider"?"Provider":"Evaluator"}</button>)}
    </nav>

    {view==="board"&&<section className="jobs-board">
      <div className="jobs-filters">{STATUS_FILTERS.map(f=><button key={f} className={filter===f?"active":""} onClick={()=>setFilter(f)}>{f}</button>)}</div>
      {shown.length===0?<p className="jobs-empty">No jobs {filter==="All"?"yet":`in ${filter}`}. Create the first one.</p>:
        <div className="jobs-table" role="table">
          <div className="jobs-row jobs-head" role="row"><span>Job</span><span>Budget</span><span>Status</span><span>Provider</span><span>Evaluator</span><span>Expiry</span></div>
          {shown.map(j=><a key={j.jobId} className="jobs-row" role="row" href={`/job/${j.jobId}`}>
            <span>#{j.jobId}</span>
            <span>{formatEther(j.budget)} USDC</span>
            <span><i className={`jobs-chip st-${j.status.toLowerCase()}`}>{j.status}</i></span>
            <span>{short(j.provider)}{j.providerAgentId&&j.providerAgentId!=="0"&&reps[j.providerAgentId]!=null&&<i className="jobs-rep" title={`Reputation ${reps[j.providerAgentId]}/100`}>★ {reps[j.providerAgentId]}</i>}</span>
            <span>{short(j.evaluator)}</span>
            <span>{j.expiry?new Date(j.expiry*1000).toLocaleDateString():"—"}</span>
          </a>)}
        </div>}
    </section>}

    {view==="create"&&(!account?<button className="agent-connect" onClick={connect}>Connect wallet to create a job</button>:
      <section className="jobs-form"><p>CREATE · FUND ESCROW</p><h2>Define and fund a job</h2>
        <span>Funds are escrowed on-chain the moment you create. The evaluator you name is the only address that can release or refund them.</span>
        <div className="agent-row"><label>Provider address<input value={cProvider} onChange={e=>setCProvider(e.target.value)} placeholder="0x… who delivers"/></label><label>Evaluator address<input value={cEvaluator} onChange={e=>setCEvaluator(e.target.value)} placeholder="0x… who approves"/></label></div>
        <div className="agent-row"><label>Budget (USDC)<input value={cBudget} onChange={e=>setCBudget(e.target.value)} placeholder="10"/></label><label>Expires in (days)<input value={cDays} onChange={e=>setCDays(e.target.value)} placeholder="14"/></label><label>Provider Agent ID<input value={cAgentId} onChange={e=>setCAgentId(e.target.value)} placeholder="0 = none"/></label></div>
        <label>Title<input value={cTitle} onChange={e=>setCTitle(e.target.value)} placeholder="Summarize this dataset"/></label>
        <label>Brief<input value={cBrief} onChange={e=>setCBrief(e.target.value)} placeholder="One-line summary of the work"/></label>
        <label>Requirements<input value={cReq} onChange={e=>setCReq(e.target.value)} placeholder="Acceptance criteria"/></label>
        <label>Deliverable spec<input value={cSpec} onChange={e=>setCSpec(e.target.value)} placeholder="What the provider must submit"/></label>
        <button disabled={busy||!isAddress(cProvider)||!isAddress(cEvaluator)||!cBudget||!cTitle} onClick={()=>void createJob()}>Create & fund {cBudget||"0"} USDC</button>
      </section>)}

    {view==="provider"&&(!account?<button className="agent-connect" onClick={connect}>Connect wallet to submit deliverables</button>:
      <section className="jobs-form"><p>PROVIDER · DELIVER</p><h2>Submit a deliverable</h2>
        <span>Record a deliverable reference (a URI or hash) for a job assigned to you. Its hash is written on-chain so tampering is detectable.</span>
        {mineProvider.length>0&&<div className="jobs-mine">{mineProvider.map(j=><button key={j.jobId} onClick={()=>setPJobId(j.jobId)}>#{j.jobId} · {formatEther(j.budget)} USDC</button>)}</div>}
        <div className="agent-row"><label>Job ID<input value={pJobId} onChange={e=>setPJobId(e.target.value)} placeholder="1"/></label><label>Deliverable URI / hash<input value={pDeliverable} onChange={e=>setPDeliverable(e.target.value)} placeholder="ipfs://… or https://…"/></label></div>
        <button disabled={busy||!pJobId||!pDeliverable} onClick={()=>void submitDeliverable()}>Submit deliverable</button>
      </section>)}

    {view==="evaluator"&&(!account?<button className="agent-connect" onClick={connect}>Connect wallet to evaluate</button>:
      <section className="jobs-form"><p>EVALUATOR · SETTLE</p><h2>Approve or reject</h2>
        <span>Approve to release 99.7% to the provider (0.3% fee via Arc Pay), or reject to refund the client. Record an evidence reference for your decision.</span>
        {mineEvaluator.length>0&&<div className="jobs-mine">{mineEvaluator.map(j=><button key={j.jobId} onClick={()=>setEJobId(j.jobId)}>#{j.jobId} · {formatEther(j.budget)} USDC</button>)}</div>}
        <div className="agent-row"><label>Job ID<input value={eJobId} onChange={e=>setEJobId(e.target.value)} placeholder="1"/></label><label>Evidence URI / hash<input value={eEvidence} onChange={e=>setEEvidence(e.target.value)} placeholder="ipfs://… or https://…"/></label></div>
        <div className="jobs-decision"><button disabled={busy||!eJobId} onClick={()=>void evaluate(true)}>Approve & settle</button><button className="danger" disabled={busy||!eJobId} onClick={()=>void evaluate(false)}>Reject & refund</button></div>
      </section>)}

    {status&&<p className="agent-status">{status}</p>}
    <footer><span>Settlement routes through Arc Pay ({short(AGENT_JOBS_ADDRESS)} escrows funds per job). Not production/mainnet-ready — Arc is testnet.</span><a href="/agentpay">Agent Pay →</a></footer>
  </main>;
}

import {useCallback,useEffect,useState} from "react";
import {BrowserProvider,Contract,formatEther,id,isAddress} from "ethers";
import {AGENT_JOBS_ADDRESS,AGENT_JOBS_ABI,ARC,REPUTATION_REGISTRY_ADDRESS,REPUTATION_REGISTRY_ABI,VALIDATION_REGISTRY_ADDRESS,VALIDATION_REGISTRY_ABI} from "../config";
import {readJob,fetchJobsFeed,type OnchainJob,type FeedJob} from "../lib/jobs";
import "./AgentPay.css";
import "./Jobs.css";

type Props={jobId:string;account:string;chainId:number|null;activeProvider:EthereumProvider|null;connect:()=>void};
const short=(x:string)=>x?`${x.slice(0,6)}…${x.slice(-4)}`:"—";
const eqAddr=(a:string,b:string)=>Boolean(a&&b&&a.toLowerCase()===b.toLowerCase());
const ZERO="0x0000000000000000000000000000000000000000000000000000000000000000";
const STEPS=["Funded","Submitted","Completed"];

export default function JobDetail({jobId,account,chainId,activeProvider,connect}:Props){
  const [job,setJob]=useState<OnchainJob|null>(null);
  const [feed,setFeed]=useState<FeedJob|null>(null);
  const [err,setErr]=useState("");const [status,setStatus]=useState("");const [busy,setBusy]=useState(false);
  const [fbScore,setFbScore]=useState("90");const [validator,setValidator]=useState("");const [valScore,setValScore]=useState("80");
  const [repScore,setRepScore]=useState<number|null>(null);

  const load=useCallback(async()=>{
    try{
      const j=await readJob(jobId);setJob(j);
      const all=await fetchJobsFeed();setFeed(all.find(f=>f.jobId===String(jobId))||null);
    }catch(e){setErr(e instanceof Error?e.message:"Failed to load job");}
  },[jobId]);
  useEffect(()=>{void load();},[load,status]);
  useEffect(()=>{if(!job||job.providerAgentId==="0")return;fetch("/developers/reputation.json",{cache:"no-store"}).then(r=>r.ok?r.json():null).then(d=>{const a=(d?.agents||[]).find((a:any)=>String(a.agentId)===job.providerAgentId);setRepScore(a?a.score:null);}).catch(()=>{});},[job]);

  async function signer(){
    if(!activeProvider){connect();throw new Error("Connect wallet first");}
    if(chainId!==ARC.id){await activeProvider.request({method:"wallet_switchEthereumChain",params:[{chainId:ARC.hexId}]});throw new Error("Network switched. Review and submit again.");}
    return new BrowserProvider(activeProvider).getSigner();
  }
  async function run(label:string,fn:(s:any)=>Promise<any>){
    setBusy(true);setStatus(`${label}: waiting for wallet…`);
    try{const s=await signer();const tx=await fn(s);setStatus(`${label} submitted ${short(tx.hash)}…`);await tx.wait();setStatus(`${label} confirmed ${tx.hash}`);}
    catch(e){setStatus(e instanceof Error?e.message:`${label} failed`);}finally{setBusy(false);}
  }
  const reclaim=()=>run("Reclaim",s=>new Contract(AGENT_JOBS_ADDRESS,AGENT_JOBS_ABI,s).reclaimExpired(BigInt(jobId)));
  const leaveFeedback=()=>run("Feedback",s=>new Contract(REPUTATION_REGISTRY_ADDRESS,REPUTATION_REGISTRY_ABI,s).giveFeedback(BigInt(job!.providerAgentId),Number(fbScore),"arcjob",jobId,feed?.evidenceHash||"",feed?.evidenceHash&&/^0x[0-9a-fA-F]{64}$/.test(feed.evidenceHash)?feed.evidenceHash:id(`arcjob:${jobId}`)));
  const requestValidation=()=>run("Validation request",s=>new Contract(VALIDATION_REGISTRY_ADDRESS,VALIDATION_REGISTRY_ABI,s).validationRequest(validator,BigInt(job!.providerAgentId),job!.deliverableHash));
  const submitValidation=()=>run("Validation response",s=>new Contract(VALIDATION_REGISTRY_ADDRESS,VALIDATION_REGISTRY_ABI,s).validationResponse(job!.deliverableHash,Number(valScore)));

  if(err)return <section className="agent-profile"><p>AGENT JOBS</p><h1>Job #{jobId}</h1><p className="err">{err}</p><p><a href="/jobs">← Back to jobs</a></p></section>;
  if(!job)return <section className="agent-profile"><p>AGENT JOBS</p><h1>Job #{jobId}</h1><p>Loading…</p></section>;

  const now=Math.floor(Date.now()/1000);
  const reclaimable=(job.status==="Funded"||job.status==="Submitted")&&now>job.expiry;
  const terminal=job.status==="Completed"?"Completed":job.status==="Rejected"?"Rejected":job.status==="Expired"?"Expired":"";
  const submitted=job.deliverableHash!==ZERO||["Submitted","Completed","Rejected"].includes(job.status);
  // Per-step state: [done?, active?] — active marks the step currently awaited.
  const stepState=[
    {done:true,active:false},                                        // Funded (always, once created)
    {done:submitted,active:job.status==="Funded"&&!terminal},        // Submitted (awaited while Funded)
    {done:Boolean(terminal),active:job.status==="Submitted"},        // terminal (awaited while Submitted)
  ];

  return <section className="agent-profile job-detail">
    <p>AGENT JOBS · OUTCOME ESCROW</p><h1>Job #{jobId}</h1>
    <div className={`job-steps st-terminal-${terminal.toLowerCase()}`}>
      {STEPS.map((s,i)=>{
        const {done,active}=stepState[i];
        const label=i===2&&terminal?terminal:s;
        return <span key={s} className={`job-step${done?" done":""}${active?" active":""}`}><i>{done?"●":active?"◉":"○"}</i>{label}</span>;
      })}
    </div>

    <dl>
      <dt>Status</dt><dd><i className={`jobs-chip st-${job.status.toLowerCase()}`}>{job.status}</i></dd>
      <dt>Budget</dt><dd>{formatEther(job.budget)} USDC{job.status==="Completed"&&<> · provider received {(Number(formatEther(job.budget))*0.997).toFixed(4)} (0.3% fee)</>}</dd>
      <dt>Client</dt><dd>{job.client}</dd>
      <dt>Provider</dt><dd>{job.provider}{job.providerAgentId!=="0"&&<> · <a href={`/agent/${job.providerAgentId}`}>Agent #{job.providerAgentId} ↗</a>{repScore!=null&&<i className="jobs-rep" title={`Reputation ${repScore}/100`}>★ {repScore}</i>}</>}</dd>
      <dt>Evaluator</dt><dd>{job.evaluator}</dd>
      <dt>Expiry</dt><dd>{new Date(job.expiry*1000).toLocaleString()} {reclaimable&&<b className="job-expired-tag">expired</b>}</dd>
      <dt>Description hash</dt><dd>{job.descHash===ZERO?"— none —":job.descHash}</dd>
      <dt>Deliverable</dt><dd>{job.deliverableHash===ZERO?"— not submitted —":job.deliverableHash}</dd>
      {feed?.evidenceHash&&<><dt>Evaluation evidence</dt><dd>{feed.evidenceHash}</dd></>}
      {feed?.settleTx&&<><dt>Settlement receipt</dt><dd><a href={`${ARC.explorer}/tx/${feed.settleTx}`} target="_blank" rel="noreferrer">{short(feed.settleTx)} ↗</a> (Arc Pay)</dd></>}
      <dt>Contract</dt><dd><a href={`${ARC.explorer}/address/${AGENT_JOBS_ADDRESS}`} target="_blank" rel="noreferrer">{short(AGENT_JOBS_ADDRESS)} ↗</a></dd>
    </dl>

    {reclaimable&&<div className="job-reclaim">
      <b>This job has expired without a decision.</b>
      <span>Anyone can trigger a refund of the full {formatEther(job.budget)} USDC budget back to the client.</span>
      {account?<button disabled={busy} onClick={()=>void reclaim()}>Reclaim to client</button>:<button onClick={connect}>Connect wallet to reclaim</button>}
    </div>}

    {job.status==="Completed"&&<div className="job-trust">
      {/* Tier 2 — verified feedback from the client/evaluator about the provider's identity */}
      <section className="jobs-form"><p>REPUTATION · LEAVE VERIFIED FEEDBACK</p><h2>Rate the provider</h2>
        {job.providerAgentId==="0"?<span>The provider has no ERC-8004 identity, so feedback can't be attached. (Feedback is agent-identity-keyed.)</span>:
         !account?<button className="agent-connect" onClick={connect}>Connect wallet</button>:
         !(eqAddr(account,job.client)||eqAddr(account,job.evaluator))?<span>Only this job's client or evaluator can leave verified feedback.</span>:<>
          <span>Posts to the official ERC-8004 Reputation Registry for <a href={`/agent/${job.providerAgentId}`}>Agent #{job.providerAgentId}</a>, tagged to this job so the indexer marks it evidence-backed.</span>
          <label>Score (0–100)<input value={fbScore} onChange={e=>setFbScore(e.target.value)} placeholder="90"/></label>
          <button disabled={busy||!fbScore} onClick={()=>void leaveFeedback()}>Leave verified feedback</button>
        </>}
      </section>
      {/* Tier 3 — independent validation */}
      <section className="jobs-form"><p>VALIDATION · INDEPENDENT ATTESTATION</p><h2>Request or submit validation</h2>
        {job.providerAgentId==="0"?<span>Validation is agent-identity-keyed; this provider has no ERC-8004 identity.</span>:!account?<button className="agent-connect" onClick={connect}>Connect wallet</button>:<>
          <span>Point an independent validator (not the client/provider/evaluator) at this job's deliverable, or respond if you are that validator.</span>
          <div className="agent-row"><label>Validator address<input value={validator} onChange={e=>setValidator(e.target.value)} placeholder="0x… independent validator"/></label></div>
          <div className="jobs-decision"><button disabled={busy||!isAddress(validator)} onClick={()=>void requestValidation()}>Request validation</button>
          <button disabled={busy} onClick={()=>void submitValidation()}>Submit validation ({valScore}/100)</button></div>
          <label>Validator response (0–100)<input value={valScore} onChange={e=>setValScore(e.target.value)} placeholder="80"/></label>
        </>}
      </section>
    </div>}

    {status&&<p className="agent-status">{status}</p>}
    <p><a href="/jobs">← Back to jobs</a></p>
  </section>;
}

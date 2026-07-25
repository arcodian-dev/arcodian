import {useCallback,useEffect,useState} from "react";
import {BrowserProvider,Contract,formatEther} from "ethers";
import {AGENT_JOBS_ADDRESS,AGENT_JOBS_ABI,ARC} from "../config";
import {readJob,fetchJobsFeed,type OnchainJob,type FeedJob} from "../lib/jobs";
import "./AgentPay.css";
import "./Jobs.css";

type Props={jobId:string;account:string;chainId:number|null;activeProvider:EthereumProvider|null;connect:()=>void};
const short=(x:string)=>x?`${x.slice(0,6)}…${x.slice(-4)}`:"—";
const ZERO="0x0000000000000000000000000000000000000000000000000000000000000000";
const STEPS=["Funded","Submitted","Completed"];

export default function JobDetail({jobId,account,chainId,activeProvider,connect}:Props){
  const [job,setJob]=useState<OnchainJob|null>(null);
  const [feed,setFeed]=useState<FeedJob|null>(null);
  const [err,setErr]=useState("");const [status,setStatus]=useState("");const [busy,setBusy]=useState(false);

  const load=useCallback(async()=>{
    try{
      const j=await readJob(jobId);setJob(j);
      const all=await fetchJobsFeed();setFeed(all.find(f=>f.jobId===String(jobId))||null);
    }catch(e){setErr(e instanceof Error?e.message:"Failed to load job");}
  },[jobId]);
  useEffect(()=>{void load();},[load,status]);

  async function reclaim(){
    setBusy(true);setStatus("Reclaim: waiting for wallet…");
    try{
      if(!activeProvider){connect();throw new Error("Connect wallet first");}
      if(chainId!==ARC.id){await activeProvider.request({method:"wallet_switchEthereumChain",params:[{chainId:ARC.hexId}]});throw new Error("Network switched. Review and submit again.");}
      const s=await new BrowserProvider(activeProvider).getSigner();
      const c=new Contract(AGENT_JOBS_ADDRESS,AGENT_JOBS_ABI,s);
      const tx=await c.reclaimExpired(BigInt(jobId));setStatus(`Reclaim submitted ${short(tx.hash)}…`);await tx.wait();
      setStatus(`Reclaim confirmed ${tx.hash}`);
    }catch(e){setStatus(e instanceof Error?e.message:"Reclaim failed");}finally{setBusy(false);}
  }

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
      <dt>Provider</dt><dd>{job.provider}{job.providerAgentId!=="0"&&<> · <a href={`/agent/${job.providerAgentId}`}>Agent #{job.providerAgentId} ↗</a></>}</dd>
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

    {status&&<p className="agent-status">{status}</p>}
    <p><a href="/jobs">← Back to jobs</a></p>
  </section>;
}

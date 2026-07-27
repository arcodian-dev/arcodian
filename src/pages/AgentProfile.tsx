import {useEffect,useState} from "react";
import {Contract,JsonRpcProvider,formatEther} from "ethers";
import {ARC,IDENTITY_REGISTRY_ADDRESS,IDENTITY_REGISTRY_ABI,AGENT_PASSPORT_ADDRESS,AGENT_PASSPORT_ABI} from "../config";
import {describeTxError} from "../txError";
import "./AgentPay.css";
import "./AgentProfile.css";

// Resolve an ipfs:// tokenURI to a fetchable gateway URL. NOTE: this does not
// recompute/verify the CID against the fetched bytes, so an ipfs:// fetch only
// proves "a gateway returned 200" — it trusts the gateway, not a cryptographic
// check. That's a materially weaker guarantee than the non-ipfs sha256 path
// below, so the UI must not label both "verified" with identical text.
function toFetchUrl(uri:string){return uri.startsWith("ipfs://")?`https://gateway.pinata.cloud/ipfs/${uri.slice(7)}`:uri;}
const short=(x:string)=>x?`${x.slice(0,6)}…${x.slice(-4)}`:"—";
const pct=(x:number)=>`${Math.round((x||0)*100)}%`;
const FLAG_LABEL:Record<string,string>={self_review:"Self-review",reciprocal_ring:"Reciprocal ring",duplicate_evidence:"Duplicate evidence",reputation_burst:"Reputation burst",counterparty_concentration:"Counterparty concentration",non_independent_validator:"Non-independent validator"};

export default function AgentProfile({agentId}:{agentId:string}){
  const [owner,setOwner]=useState("");const [wallet,setWallet]=useState("");const [uri,setUri]=useState("");
  const [meta,setMeta]=useState<any>(null);const [integrity,setIntegrity]=useState<"hash"|"gateway"|"fail"|"unknown">("unknown");const [err,setErr]=useState("");
  const [rep,setRep]=useState<any>(null);const [repLoaded,setRepLoaded]=useState(false);
  useEffect(()=>{(async()=>{if(!agentId)return;const p=new JsonRpcProvider(ARC.rpc,undefined,{batchMaxCount:1});try{
    const reg=new Contract(IDENTITY_REGISTRY_ADDRESS,IDENTITY_REGISTRY_ABI,p);const pp=new Contract(AGENT_PASSPORT_ADDRESS,AGENT_PASSPORT_ABI,p);
    const [o,u,w]=await Promise.all([reg.ownerOf(agentId),reg.tokenURI(agentId),pp.walletOf(agentId)]);
    setOwner(o);setUri(u);setWallet(w);
    const res=await fetch(toFetchUrl(u));const text=await res.text();setMeta(JSON.parse(text));
    if(u.startsWith("ipfs://")){setIntegrity(res.ok?"gateway":"fail");}
    else{const want=new URL(u).searchParams.get("sha256");const got=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text)))).map(b=>b.toString(16).padStart(2,"0")).join("");setIntegrity(want&&want===got?"hash":"fail");}
  }catch(e){setErr(describeTxError(e));}finally{p.destroy();}})();},[agentId]);
  useEffect(()=>{fetch("/developers/reputation.json",{cache:"no-store"}).then(r=>r.ok?r.json():null).then(d=>{setRep((d?.agents||[]).find((a:any)=>String(a.agentId)===String(agentId))||null);setRepLoaded(true);}).catch(()=>setRepLoaded(true));},[agentId]);

  const evidenceBacked=(rep?.feedback||[]).filter((f:any)=>f.evidenceBacked);
  const unverified=(rep?.feedback||[]).filter((f:any)=>!f.evidenceBacked);
  return <section className="agent-profile">
    <header className="agent-profile-hero"><div><p>ERC-8004 AGENT PASSPORT</p><h1>Agent #{agentId}</h1>{meta&&<><h2>{meta.name}</h2><span>{meta.description}</span></>}</div>
    <aside>{meta?.image?<img src={meta.image} alt={meta.name}/>:<b>#{agentId}</b>}<small className={integrity==="hash"?"ok":integrity==="gateway"?"ok":integrity==="fail"?"bad":""} title={integrity==="gateway"?"IPFS gateway returned this content, but the CID was not recomputed against it — this trusts the gateway, not a cryptographic proof.":integrity==="hash"?"SHA-256 of the fetched metadata matches the hash committed in its own URI.":undefined}>{integrity==="hash"?"✓ Hash verified":integrity==="gateway"?"✓ Gateway served":integrity==="fail"?"⚠ Integrity failed":"Reading identity…"}</small></aside></header>
    {err&&<p className="err">Identity metadata unavailable: {err}</p>}
    <section className="agent-binding"><p>IDENTITY BINDING</p><dl><dt>Owner</dt><dd>{owner||"…"}</dd><dt>Authorized wallet</dt><dd>{wallet&&wallet!=="0x0000000000000000000000000000000000000000"?wallet:"— not bound —"}</dd>
    <dt>Metadata URI</dt><dd>{uri||"…"}</dd>
    <dt>Metadata integrity</dt><dd>{integrity==="hash"?"✓ SHA-256 verified against its own URI":integrity==="gateway"?"✓ served by IPFS gateway (not hash-checked)":integrity==="fail"?"⚠ integrity failed":"…"}</dd>
    <dt>Capabilities</dt><dd>{meta?.capabilities?.join(", ")||"—"}</dd><dt>Payment modes</dt><dd>{meta?.supportedPaymentModes?.join(", ")||"—"}</dd></dl></section>

    <section className="rep">
      <p className="rep-kicker">REPUTATION · VERIFIED OUTCOMES</p>
      {!repLoaded?<p>Loading reputation…</p>:!rep?<aside className="rep-empty"><b>No settled jobs indexed yet.</b><span>Reputation appears once this agent completes jobs on <a href="/jobs">Agent Jobs</a>.</span></aside>:<>
        {/* Tier 1 — settlement record */}
        <div className="rep-head">
          <div className="rep-score"><strong>{rep.score}</strong><small>/100</small></div>
          <div className="rep-headmeta">
            <b>Settlement record</b>
            <span>{rep.counts.completed} completed · {rep.counts.rejected} rejected · {rep.counts.expired} expired · confidence {pct(rep.confidence)}</span>
            <a href="/reputation-methodology.md" target="_blank" rel="noreferrer">How this is calculated ↗</a>
          </div>
        </div>
        <div className="rep-bars">
          {([["Completion",rep.dimensions.completionRate],["Reliability",rep.dimensions.reliability],["Timeliness",rep.dimensions.timeliness]] as [string,number][]).map(([l,v])=>
            <div key={l} className="rep-bar"><label>{l}<em>{pct(v)}</em></label><div className="rep-track"><i style={{width:pct(v)}}/></div></div>)}
        </div>
        <div className="rep-context">
          <article><small>SETTLED VOLUME</small><strong>{Number(formatEther(rep.context.settledVolume||"0")).toFixed(2)} USDC</strong></article>
          <article><small>DISTINCT CLIENTS</small><strong>{rep.context.distinctClients}</strong></article>
          <article><small>DISTINCT EVALUATORS</small><strong>{rep.context.distinctEvaluators}</strong></article>
        </div>
        {rep.flags?.length>0&&<div className="rep-flags">{rep.flags.map((f:string)=><span key={f} className="rep-flag">⚑ {FLAG_LABEL[f]||f}</span>)}</div>}
        {rep.excludedJobIds?.length>0&&<p className="rep-note">Excluded from score: {rep.excludedJobIds.map((id:string)=><a key={id} href={`/job/${id}`}>#{id} </a>)}</p>}

        {/* Tier 2 — feedback */}
        <div className="rep-tier"><b>Client / evaluator feedback</b>
          {evidenceBacked.length===0&&unverified.length===0?<span className="rep-muted">No feedback yet.</span>:<>
            {evidenceBacked.map((f:any,i:number)=><div key={"e"+i} className="rep-fb"><i className="jobs-chip st-completed">✓ evidence-backed</i> <b>{f.score}/100</b> from {short(f.client)} {f.jobId&&<a href={`/job/${f.jobId}`}>· job #{f.jobId}</a>}</div>)}
            {unverified.map((f:any,i:number)=><div key={"u"+i} className="rep-fb unverified"><i className="jobs-chip st-expired">unverified</i> <b>{f.score}/100</b> from {short(f.client)} — not tied to a completed job</div>)}
          </>}
        </div>

        {/* Tier 3 — independent validation */}
        <div className="rep-tier"><b>Independent validation</b>
          {(rep.validation?.independentCount||0)===0?<span className="rep-muted">No independent validations yet.</span>:<>
            <span>{rep.validation.independentCount} independent · avg {rep.validation.averageScore}/100</span>
            {(rep.validation.items||[]).filter((v:any)=>v.independent).map((v:any,i:number)=><div key={i} className="rep-fb"><i className="jobs-chip st-completed">validated</i> <b>{v.response}/100</b> by {short(v.validator)} {v.jobId&&<a href={`/job/${v.jobId}`}>· job #{v.jobId}</a>}</div>)}
          </>}
        </div>
      </>}
    </section>
    <p><a href="/agentpay">← Back to Agent Pay</a> · <a href="/jobs">Agent Jobs →</a></p>
  </section>;
}

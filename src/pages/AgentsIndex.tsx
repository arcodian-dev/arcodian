import {useEffect,useState} from "react";
import "./AgentPay.css";
import "./AgentProfile.css";

type RepAgent={agentId:string|null;providerWallet:string;score:number;confidence:number;counts:{completed:number;rejected:number;expired:number;total:number}};
const short=(x:string)=>x?`${x.slice(0,6)}…${x.slice(-4)}`:"—";

// No dedicated agent-discovery indexer exists yet — reputation.json is the
// only feed that already lists every agentId that has done real work, so
// it doubles as the browse list until a purpose-built one exists. Agents
// with no on-chain agentId (feedback given by wallet only, pre-Passport)
// are shown but not linkable, since there's no /agent/:id for them.
export default function AgentsIndex(){
  const [agents,setAgents]=useState<RepAgent[]|null>(null);
  useEffect(()=>{fetch("/developers/reputation.json",{cache:"no-store"}).then(r=>r.ok?r.json():null).then(d=>setAgents(d?.agents||[])).catch(()=>setAgents([]));},[]);
  const sorted=(agents||[]).slice().sort((a,b)=>b.score-a.score);
  return <main className="agent-pay">
    <header><p>AGENT DIRECTORY · ERC-8004</p><h1>Browse<br/>registered agents.</h1><span>Every agent below has at least one settled Agent Jobs outcome. Reputation is objective — computed from completion/rejection/expiry counts, not self-reported.</span></header>
    <section className="agent-metrics"><article><small>AGENTS INDEXED</small><strong>{sorted.length}</strong></article><article><small>WITH ON-CHAIN ID</small><strong>{sorted.filter(a=>a.agentId).length}</strong></article></section>
    {agents===null?<p className="agent-status">Loading agents…</p>:sorted.length===0?<p className="agent-status">No agents with settled jobs yet — the first one to complete a job on <a href="/jobs">Agent Jobs</a> shows up here.</p>:
      <div className="agent-grid" style={{gridTemplateColumns:"1fr",marginTop:24}}>
        {sorted.map((a,i)=><section key={a.agentId||`w${i}`} style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:16}}>
          <div><p style={{margin:0}}>{a.agentId?`AGENT #${a.agentId}`:"UNIDENTIFIED PROVIDER"}</p><h2 style={{margin:"4px 0"}}>{short(a.providerWallet)}</h2><span>{a.counts.completed} completed · {a.counts.rejected} rejected · {a.counts.expired} expired</span></div>
          <div style={{textAlign:"right"}}><strong style={{fontSize:28,display:"block"}}>{a.score}</strong><small>/100 · {Math.round(a.confidence*100)}% confidence</small>{a.agentId&&<div style={{marginTop:8}}><a href={`/agent/${a.agentId}`}>View profile ↗</a></div>}</div>
        </section>)}
      </div>}
  </main>;
}

import {useEffect,useState} from "react";
import {Contract,JsonRpcProvider} from "ethers";
import {ARC,IDENTITY_REGISTRY_ADDRESS,IDENTITY_REGISTRY_ABI,AGENT_PASSPORT_ADDRESS,AGENT_PASSPORT_ABI} from "../config";

// Resolve an ipfs:// tokenURI to a fetchable gateway URL. For ipfs:// the CID is
// the content hash, so a successful gateway fetch of that CID is self-verifying.
function toFetchUrl(uri:string){return uri.startsWith("ipfs://")?`https://gateway.pinata.cloud/ipfs/${uri.slice(7)}`:uri;}

export default function AgentProfile({agentId}:{agentId:string}){
  const [owner,setOwner]=useState("");const [wallet,setWallet]=useState("");const [uri,setUri]=useState("");
  const [meta,setMeta]=useState<any>(null);const [integrity,setIntegrity]=useState<"ok"|"fail"|"unknown">("unknown");const [err,setErr]=useState("");
  useEffect(()=>{(async()=>{if(!agentId)return;const p=new JsonRpcProvider(ARC.rpc,undefined,{batchMaxCount:1});try{
    const reg=new Contract(IDENTITY_REGISTRY_ADDRESS,IDENTITY_REGISTRY_ABI,p);const pp=new Contract(AGENT_PASSPORT_ADDRESS,AGENT_PASSPORT_ABI,p);
    const [o,u,w]=await Promise.all([reg.ownerOf(agentId),reg.tokenURI(agentId),pp.walletOf(agentId)]);
    setOwner(o);setUri(u);setWallet(w);
    const res=await fetch(toFetchUrl(u));const text=await res.text();setMeta(JSON.parse(text));
    // ipfs:// is content-addressed (CID == hash of bytes) -> self-verifying. Host fallback carries ?sha256=.
    if(u.startsWith("ipfs://")){setIntegrity(res.ok?"ok":"fail");}
    else{const want=new URL(u).searchParams.get("sha256");const got=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text)))).map(b=>b.toString(16).padStart(2,"0")).join("");setIntegrity(want&&want===got?"ok":"fail");}
  }catch(e){setErr(e instanceof Error?e.message:"Failed to load agent");}finally{p.destroy();}})();},[agentId]);
  if(err)return <section className="agent-profile"><p>ERC-8004 AGENT PASSPORT</p><h1>Agent #{agentId}</h1><p className="err">{err}</p><p><a href="/agentpay">← Back to Agent Pay</a></p></section>;
  return <section className="agent-profile">
    <p>ERC-8004 AGENT PASSPORT</p><h1>Agent #{agentId}</h1>
    {meta&&<><h2>{meta.name}</h2><p>{meta.description}</p>{meta.image&&<img src={meta.image} alt={meta.name} style={{maxWidth:160,borderRadius:12}}/>}</>}
    <dl><dt>Owner</dt><dd>{owner||"…"}</dd><dt>Authorized wallet</dt><dd>{wallet&&wallet!=="0x0000000000000000000000000000000000000000"?wallet:"— not bound —"}</dd>
    <dt>Metadata URI</dt><dd>{uri||"…"}</dd>
    <dt>Metadata integrity</dt><dd>{integrity==="ok"?"✓ verified":integrity==="fail"?"⚠ integrity failed":"…"}</dd>
    <dt>Capabilities</dt><dd>{meta?.capabilities?.join(", ")||"—"}</dd><dt>Payment modes</dt><dd>{meta?.supportedPaymentModes?.join(", ")||"—"}</dd></dl>
    <aside className="phase-pending"><b>Reputation &amp; validations</b><span>Pending Phase C — no reputation is written until the ERC-8004 outcome methodology is live.</span></aside>
    <p><a href="/agentpay">← Back to Agent Pay</a></p>
  </section>;
}

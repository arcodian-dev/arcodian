import {Contract,JsonRpcProvider,keccak256,toUtf8Bytes,parseEther} from "ethers";
import {AGENT_JOBS_ADDRESS,AGENT_JOBS_ABI,JOB_METADATA_ENDPOINT,ARC} from "../config";

export const JOB_STATUS=["None","Funded","Submitted","Completed","Rejected","Expired"] as const;
export type JobStatus=typeof JOB_STATUS[number];

export type JobDescription={title:string;brief?:string;requirements?:string;deliverableSpec?:string;budgetUSDC?:string;provider?:string;evaluator?:string};
export type FeedJob={jobId:string;client:string;provider:string;evaluator:string;budget:string;expiry:number;status:JobStatus;descHash:string;deliverableHash?:string;evidenceHash?:string;providerAgentId:string;createdBlock?:number;updatedBlock?:number;settleTx?:string};
export type OnchainJob={jobId:string;client:string;provider:string;evaluator:string;budget:bigint;expiry:number;status:JobStatus;descHash:string;deliverableHash:string;providerAgentId:string};

// Canonical JSON so the on-chain descHash is deterministic per content (matches the PHP pin).
export function canonicalJson(obj:unknown):string{return JSON.stringify(obj);}
export function hashJson(obj:unknown):string{return keccak256(toUtf8Bytes(canonicalJson(obj)));}
// Hash an arbitrary string reference (deliverable / evidence URI) unless already a 32-byte hex.
export function hashRef(ref:string):string{return /^0x[0-9a-fA-F]{64}$/.test(ref)?ref:keccak256(toUtf8Bytes(ref));}

function reader(){return new JsonRpcProvider(ARC.rpc,undefined,{batchMaxCount:1});}

// Pin a job description to IPFS via the server endpoint, returning the URI + on-chain descHash.
export async function pinJobDescription(desc:JobDescription):Promise<{url:string;hash:string}>{
  const res=await fetch(JOB_METADATA_ENDPOINT,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(desc)});
  if(!res.ok)throw new Error("Description pin failed");
  const {url}=await res.json();if(!url)throw new Error("No metadata URI returned");
  return {url,hash:hashJson(desc)};
}

export async function readJobCount():Promise<number>{
  const p=reader();try{return Number(await new Contract(AGENT_JOBS_ADDRESS,AGENT_JOBS_ABI,p).jobCount());}finally{p.destroy();}
}
export async function readJob(jobId:string|number):Promise<OnchainJob>{
  const p=reader();try{
    const j=await new Contract(AGENT_JOBS_ADDRESS,AGENT_JOBS_ABI,p).jobs(jobId);
    return {jobId:String(jobId),client:j.client,provider:j.provider,evaluator:j.evaluator,budget:j.budget,expiry:Number(j.expiry),status:JOB_STATUS[Number(j.status)]||"None",descHash:j.descHash,deliverableHash:j.deliverableHash,providerAgentId:j.providerAgentId.toString()};
  }finally{p.destroy();}
}

// Public indexed feed (tolerate 404 / missing during first index).
export async function fetchJobsFeed():Promise<FeedJob[]>{
  try{const res=await fetch("/developers/jobs.json",{cache:"no-store"});if(!res.ok)return [];const d=await res.json();return Array.isArray(d)?d:(d.jobs||[]);}catch{return [];}
}

// Fetch the pinned description JSON for a job and verify its hash matches descHash on-chain.
export async function fetchDescription(uri:string,descHash:string):Promise<{ok:boolean;desc:JobDescription|null}>{
  try{
    const url=uri.startsWith("ipfs://")?`https://gateway.pinata.cloud/ipfs/${uri.slice(7)}`:uri;
    const res=await fetch(url);if(!res.ok)return {ok:false,desc:null};
    const desc=await res.json();
    return {ok:hashJson(desc).toLowerCase()===descHash.toLowerCase(),desc};
  }catch{return {ok:false,desc:null};}
}

// tx-builders: called with a live Contract bound to a signer (see each page's submit()).
export const budgetValue=(usdc:string)=>({value:parseEther(usdc||"0")});

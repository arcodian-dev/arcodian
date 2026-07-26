import {JsonRpcProvider,Interface} from "ethers";
import {readFileSync,writeFileSync} from "node:fs";
const RPC=process.env.ARC_RPC_URL||"https://rpc.testnet.arc.network/";
const JOBS=process.env.AGENT_JOBS_ADDRESS||"0x33f54C516107A8c67d9Dc245f00E253132a6D15A";
const OUT=process.env.JOB_INDEX_OUT||"public/developers/jobs.json";
const STATE=`${OUT}.state.json`;
const DEPLOY_BLOCK=Number(process.env.JOB_DEPLOY_BLOCK||53_590_959);
const CHUNK=9_500;const MAX_CATCHUP=Number(process.env.JOB_MAX_CATCHUP||30_000);
const STATUS=["None","Funded","Submitted","Completed","Rejected","Expired"];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const iface=new Interface([
  "event JobCreated(uint256 indexed jobId,address indexed client,address indexed provider,address evaluator,uint256 budget,uint64 expiry,bytes32 descHash,uint256 providerAgentId)",
  "event JobSubmitted(uint256 indexed jobId,bytes32 deliverableHash)",
  "event JobCompleted(uint256 indexed jobId,address indexed provider,uint256 budget,uint256 providerAgentId,bytes32 evidenceHash)",
  "event JobRejected(uint256 indexed jobId,address indexed client,uint256 budget,bytes32 evidenceHash)",
  "event JobExpired(uint256 indexed jobId,address indexed client,uint256 budget)"
]);
const T={
  created:iface.getEvent("JobCreated").topicHash,
  submitted:iface.getEvent("JobSubmitted").topicHash,
  completed:iface.getEvent("JobCompleted").topicHash,
  rejected:iface.getEvent("JobRejected").topicHash,
  expired:iface.getEvent("JobExpired").topicHash,
};
function loadState(){try{return JSON.parse(readFileSync(STATE,"utf8"));}catch{return null;}}
async function getLogs(provider,params){for(let a=0;a<5;a++){try{return await provider.getLogs(params);}catch(e){const m=String(e?.message||e);if(/limit reached|rate|429|-32011/.test(m)){await sleep(1500*(a+1));continue;}throw e;}}throw Error("getLogs retries exhausted");}
async function main(){
  const provider=new JsonRpcProvider(RPC,undefined,{batchMaxCount:1});
  const tip=await provider.getBlockNumber();
  const prev=loadState();
  const jobs=prev?.jobs||{};
  const tsCache=new Map();
  const blockTs=async bn=>{if(tsCache.has(bn))return tsCache.get(bn);const b=await provider.getBlock(bn);const t=Number(b.timestamp);tsCache.set(bn,t);return t;};
  let start=prev?prev.indexedBlock+1:Math.max(DEPLOY_BLOCK,tip-MAX_CATCHUP);
  for(let from=start;from<=tip;from+=CHUNK){
    const to=Math.min(tip,from+CHUNK-1);
    const logs=await getLogs(provider,{address:JOBS,topics:[[T.created,T.submitted,T.completed,T.rejected,T.expired]],fromBlock:from,toBlock:to});
    // chronological fold so status reflects the latest lifecycle event
    logs.sort((a,b)=>a.blockNumber-b.blockNumber||a.index-b.index);
    for(const l of logs){
      const e=iface.parseLog(l);const id=e.args.jobId.toString();
      const j=jobs[id]||{jobId:id};
      j.updatedBlock=l.blockNumber;j.updatedTx=l.transactionHash;
      if(e.name==="JobCreated"){
        j.client=e.args.client;j.provider=e.args.provider;j.evaluator=e.args.evaluator;
        j.budget=e.args.budget.toString();j.expiry=Number(e.args.expiry);
        j.descHash=e.args.descHash;j.providerAgentId=e.args.providerAgentId.toString();
        j.status="Funded";j.createdBlock=l.blockNumber;j.createdAt=await blockTs(l.blockNumber);
      } else if(e.name==="JobSubmitted"){
        j.deliverableHash=e.args.deliverableHash;j.status="Submitted";j.submittedBlock=l.blockNumber;j.submittedAt=await blockTs(l.blockNumber);
      } else if(e.name==="JobCompleted"){
        j.evidenceHash=e.args.evidenceHash;j.settleTx=l.transactionHash;j.status="Completed";
      } else if(e.name==="JobRejected"){
        j.evidenceHash=e.args.evidenceHash;j.status="Rejected";
      } else if(e.name==="JobExpired"){
        j.status="Expired";
      }
      jobs[id]=j;
    }
  }
  const list=Object.values(jobs).sort((a,b)=>Number(b.jobId)-Number(a.jobId));
  writeFileSync(OUT,JSON.stringify({indexedBlock:tip,count:list.length,statuses:STATUS,jobs:list},null,0));
  writeFileSync(STATE,JSON.stringify({indexedBlock:tip,jobs}));
  console.log(`indexed ${list.length} jobs through block ${tip}`);
  await provider.destroy?.();
}
main().catch(e=>{console.error(e);process.exit(1);});

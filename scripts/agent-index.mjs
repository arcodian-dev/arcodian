import {JsonRpcProvider,Contract,Interface,ZeroAddress} from "ethers";
import {readFileSync,writeFileSync} from "node:fs";
const RPC=process.env.ARC_RPC_URL||"https://rpc.testnet.arc.network/";
const IDENTITY=process.env.IDENTITY_REGISTRY_ADDRESS||"0x8004A818BFB912233c491871b3d84c89A494BD9e";
const PASSPORT=process.env.AGENT_PASSPORT_ADDRESS||"0xDaCEF31ca7C5B1cebB5516f541cfF05E17eC2cCf";
const OUT=process.env.AGENT_INDEX_OUT||"public/developers/agents.json";
const STATE=`${OUT}.state.json`;
const DEPLOY_BLOCK=Number(process.env.AGENT_DEPLOY_BLOCK||53_508_049);
const CHUNK=9_500;const MAX_CATCHUP=Number(process.env.AGENT_MAX_CATCHUP||30_000);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const idIface=new Interface(["event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)"]);
const ppIface=new Interface(["event WalletBound(uint256 indexed agentId,address indexed oldWallet,address indexed newWallet,address owner)","event WalletUnbound(uint256 indexed agentId,address indexed oldWallet,address owner)"]);
function loadState(){try{return JSON.parse(readFileSync(STATE,"utf8"));}catch{return null;}}
async function getLogs(provider,params){for(let a=0;a<5;a++){try{return await provider.getLogs(params);}catch(e){const m=String(e?.message||e);if(/limit reached|rate|429|-32011/.test(m)){await sleep(1500*(a+1));continue;}throw e;}}throw Error("getLogs retries exhausted");}
async function main(){
  const provider=new JsonRpcProvider(RPC,undefined,{batchMaxCount:1});
  const tip=await provider.getBlockNumber();
  const prev=loadState();
  const agents=prev?.agents||{};
  let start=prev?prev.indexedBlock+1:Math.max(DEPLOY_BLOCK,tip-MAX_CATCHUP);
  for(let from=start;from<=tip;from+=CHUNK){
    const to=Math.min(tip,from+CHUNK-1);
    const mints=await getLogs(provider,{address:IDENTITY,topics:[idIface.getEvent("Transfer").topicHash,`0x${"0".repeat(64)}`],fromBlock:from,toBlock:to});
    for(const l of mints){const e=idIface.parseLog(l);const aid=e.args.tokenId.toString();agents[aid]={...(agents[aid]||{}),agentId:aid,owner:e.args.to,mintBlock:l.blockNumber};}
    if(PASSPORT){const binds=await getLogs(provider,{address:PASSPORT,topics:[[ppIface.getEvent("WalletBound").topicHash,ppIface.getEvent("WalletUnbound").topicHash]],fromBlock:from,toBlock:to});
      for(const l of binds){const e=ppIface.parseLog(l);const aid=e.args.agentId.toString();const bound=e.name==="WalletBound"?e.args.newWallet:ZeroAddress;agents[aid]={...(agents[aid]||{agentId:aid}),wallet:bound,bindBlock:l.blockNumber};}}
  }
  writeFileSync(OUT,JSON.stringify({indexedBlock:tip,count:Object.keys(agents).length,agents},null,0));
  writeFileSync(STATE,JSON.stringify({indexedBlock:tip,agents}));
  console.log(`indexed ${Object.keys(agents).length} agents through block ${tip}`);
  await provider.destroy?.();
}
main().catch(e=>{console.error(e);process.exit(1);});

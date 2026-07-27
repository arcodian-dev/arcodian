#!/usr/bin/env node
import { Contract, JsonRpcProvider, formatEther, formatUnits } from "ethers";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const TREASURY=(process.env.ARC_TREASURY||"0xF1CBe360b45F2E22Ab74A2c434e5602f66105CaF").toLowerCase();
const RPC=process.env.ARC_RPC_URL||"https://arcodian.fun/api/rpc.php";
const OUT=process.env.TREASURY_STATS_OUTPUT||"/www/wwwroot/arcodian.fun/shared/data/treasury.json";
const EXPLORER="https://testnet.arcscan.app/api";
const ADDR={ arcpay:"0x5e3d1b63213b8608539116d1c6248a36819684b5",fx:"0x982d61ddcab6169d82b3e37a4e4158f1982e5447",lend:"0xcec317ca96b7e55fa0f9f7c243cdb0ee6bc19ced",usdc:"0x3600000000000000000000000000000000000000",eurc:"0x89b50855aa3be2f677cd6303cec089b5f319d72a" };
const KNOWN_LEGACY=new Map([
 ["0x31e4236673031e60ff7055a0adc3cae4b98f0db6","Legacy Market / OMG v4 curve"],
 ["0x05b2f9842285c790f36a4b7bbcbb5e3cf505a7e5","Legacy Market / ACAT v5 curve"],
 ["0xc5567a5e3370d4dbfb0540025078e283e36a363d","Legacy Bridge fees"],
]);
const provider=new JsonRpcProvider(RPC,undefined,{batchMaxCount:1});
const erc20=["function balanceOf(address) view returns(uint256)"];
const market=(()=>{try{return JSON.parse(readFileSync("/www/wwwroot/arcodian.fun/shared/data/market-index.json","utf8"))}catch{return {launches:[]}}})();
const marketSources=new Set((market.launches||[]).flatMap(x=>[x.curve,x.pair]).filter(Boolean).map(x=>x.toLowerCase()));
const sourceLabel=(from,txTo)=>{ from=from.toLowerCase(); txTo=(txTo||"").toLowerCase(); if(from===ADDR.arcpay||txTo===ADDR.arcpay)return ["Revenue","Arc Pay"]; if(from===ADDR.fx||txTo===ADDR.fx)return ["Revenue","Stablecoin FX"]; if(from===ADDR.lend||txTo===ADDR.lend)return ["Revenue","Arc Lend"]; if(KNOWN_LEGACY.has(from))return ["Revenue",KNOWN_LEGACY.get(from)]; if(marketSources.has(from)||marketSources.has(txTo))return ["Revenue","Market / DEX"]; return ["Unknown","Unattributed"]; };

async function main(){
 const url=`${EXPLORER}?module=account&action=tokentx&address=${TREASURY}&page=1&offset=1000&sort=desc`;
 const json=await fetch(url,{headers:{"user-agent":"ArcodianTreasury/1.0"}}).then(r=>r.json()); const tokenTx=Array.isArray(json.result)?json.result:[];
 const txTargets=new Map(); for(const hash of [...new Set(tokenTx.map(x=>x.hash))]){try{const tx=await provider.getTransaction(hash);txTargets.set(hash,tx?.to?.toLowerCase()||"")}catch{txTargets.set(hash,"")}}
 const entries=tokenTx.map(row=>{const inbound=row.to.toLowerCase()===TREASURY;const amount=Number(formatUnits(BigInt(row.value),Number(row.tokenDecimal||6)));const [category,source]=inbound?sourceLabel(row.from,txTargets.get(row.hash)):['Operational','Treasury outbound'];return {tx:row.hash,block:Number(row.blockNumber),timestamp:Number(row.timeStamp),direction:inbound?'in':'out',token:row.tokenSymbol,tokenAddress:row.contractAddress,amount,from:row.from,to:row.to,category,source,txTarget:txTargets.get(row.hash)||null};});
 const [native,usdc6,eurc6,tip]=await Promise.all([provider.getBalance(TREASURY),new Contract(ADDR.usdc,erc20,provider).balanceOf(TREASURY),new Contract(ADDR.eurc,erc20,provider).balanceOf(TREASURY),provider.getBlockNumber()]);
 const totals={inUsd:entries.filter(x=>x.direction==='in').reduce((s,x)=>s+x.amount,0),outUsd:entries.filter(x=>x.direction==='out').reduce((s,x)=>s+x.amount,0),revenueUsd:entries.filter(x=>x.category==='Revenue').reduce((s,x)=>s+x.amount,0),unknownUsd:entries.filter(x=>x.category==='Unknown').reduce((s,x)=>s+x.amount,0)};
 const seen=new Set();const alerts=[];for(const row of entries.filter(x=>x.direction==='out').reverse()){const recipient=row.to.toLowerCase();if(row.amount>=100)alerts.push({level:'high',type:'large-outflow',tx:row.tx,message:`Large treasury outflow: ${row.amount} ${row.token}`});if(!seen.has(recipient))alerts.push({level:'notice',type:'new-recipient',tx:row.tx,message:`First indexed transfer to ${row.to}`});seen.add(recipient)}
 const payload={version:1,chainId:5042002,treasury:TREASURY,indexedAt:new Date().toISOString(),indexedBlock:tip,balances:{nativeUsdc:Number(formatEther(native)),usdcErc20:Number(formatUnits(usdc6,6)),eurc:Number(formatUnits(eurc6,6))},totals,counts:{transactions:entries.length,inbound:entries.filter(x=>x.direction==='in').length,outbound:entries.filter(x=>x.direction==='out').length,attributed:entries.filter(x=>x.category!=='Unknown').length},alerts,entries};
 mkdirSync(dirname(OUT),{recursive:true});writeFileSync(OUT,JSON.stringify(payload,null,2));console.log(`Treasury stats written: ${OUT} (${entries.length} transfers)`);await provider.destroy();
}
main().catch(e=>{console.error(e);process.exit(1)});

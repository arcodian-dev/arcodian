#!/usr/bin/env node
import { Contract, formatEther } from "ethers";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { healthyProvider } from "./rpc-failover.mjs";

const DATA = process.env.ARC_DATA_DIR || "/www/wwwroot/arcodian.fun/shared/data";
const OUT = process.env.UNIFIED_ANALYTICS_OUTPUT || `${DATA}/analytics.json`;
const LEND = process.env.ARC_LEND_ADDRESS || "0x2f2cC1a11C75B493ea7c8f44e34a88FB5C121637";
const MESSENGER = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA";
const DEST = { 0:[11155111,"https://ethereum-sepolia-rpc.publicnode.com"],1:[43113,"https://api.avax-test.network/ext/bc/C/rpc"],2:[11155420,"https://sepolia.optimism.io"],3:[421614,"https://sepolia-rollup.arbitrum.io/rpc"],6:[84532,"https://sepolia.base.org"],7:[80002,"https://rpc-amoy.polygon.technology"] };
const TRANSMITTER = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275";
const read = (name) => { try { return JSON.parse(readFileSync(`${DATA}/${name}`, "utf8")); } catch { return null; } };
const { provider, url: rpc, candidates: rpcCandidates } = await healthyProvider({ fallback:"https://arcodian.fun/api/rpc.php" });

async function bridgeStats() {
  const api = `https://testnet.arcscan.app/api?module=account&action=txlist&address=${MESSENGER}&page=1&offset=1000&sort=desc`;
  const response = await fetch(api, { headers: { "user-agent": "ArcodianIndexer/2.0" } });
  const body = response.ok ? await response.json() : { result: [] };
  const burns = (Array.isArray(body.result) ? body.result : []).filter((tx) => String(tx.to).toLowerCase() === MESSENGER.toLowerCase() && tx.isError === "0" && String(tx.input).startsWith("0x8e0250ee"));
  const rows = new Array(burns.length); let cursor=0;
  async function worker(){ while(cursor<burns.length){ const index=cursor++; const tx=burns[index];
    const args = tx.input.slice(10); const amount = BigInt(`0x${args.slice(0,64)}`); const domain = Number(BigInt(`0x${args.slice(64,128)}`));
    let complete = false, ready = false, found = false, nonce = "";
    try {
      // Circle applies strict public sandbox limits. Verify the newest burns
      // deeply and keep older successful Arc calls as observed-only metrics.
      if(index>=25) throw new Error("outside completion verification window");
      const iris = await fetch(`https://iris-api-sandbox.circle.com/v2/messages/26?transactionHash=${tx.hash}`).then((r)=>r.json());
      const msg = iris.messages?.[0]; found=Boolean(msg); ready = msg?.status === "complete"; nonce = msg?.decodedMessage?.nonce || "";
      if (nonce && DEST[domain]) {
        const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),8000);
        const response=await fetch(DEST[domain][1],{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_call",params:[{to:TRANSMITTER,data:`0xfeb61724${nonce.slice(2)}`},"latest"]}),signal:controller.signal});
        clearTimeout(timer); const value=await response.json(); complete=BigInt(value.result||"0x0")>0n;
      }
    } catch {}
    rows[index]={ tx:tx.hash, account:tx.from, amountUsd:Number(amount)/1e6, destinationChainId:DEST[domain]?.[0]||0, timestamp:Number(tx.timeStamp), status:complete?"completed":ready?"ready":found?"pending":"unverified" };
  }}
  await Promise.all(Array.from({length:12},()=>worker()));
  const verified=rows.filter(r=>r.status!=="unverified");
  return { observedCalls:rows.length, burns:rows.length, volumeUsd:rows.reduce((s,r)=>s+r.amountUsd,0), completed:verified.filter(r=>r.status==="completed").length, pending:verified.filter(r=>r.status!=="completed").length, completionChecked:verified.length, completionUnavailable:rows.length-verified.length, recent:rows.slice(0,20) };
}

async function main() {
  const [pay, fx, market, treasury, bridge] = [read("arcpay-stats.json"), read("fx-stats.json"), read("market-index.json"), read("treasury.json"), await bridgeStats()];
  const lend = new Contract(LEND,["function totalAssets() view returns(uint256)","function totalBorrows() view returns(uint256)","function reserves() view returns(uint256)","function supplyCap() view returns(uint256)","function borrowCap() view returns(uint256)","function pauseFlags() view returns(uint256)","function badDebt() view returns(uint256)","function lastGoodPriceAt() view returns(uint64)"],provider);
  const [assets,borrows,reserves,supplyCap,borrowCap,pauseFlags,badDebt,lastGoodPriceAt,tip] = await Promise.all([lend.totalAssets(),lend.totalBorrows(),lend.reserves(),lend.supplyCap(),lend.borrowCap(),lend.pauseFlags(),lend.badDebt(),lend.lastGoodPriceAt(),provider.getBlockNumber()]);
  const trades = market?.activity || []; const launches = market?.launches || [];
  const payload = { version:1, chainId:5042002, indexedAt:new Date().toISOString(), indexedBlock:tip,
    sources:{ arcpay:pay?.indexedAt||null, fx:fx?.updatedAt||null, market:market?.indexedAt||null, treasury:treasury?.indexedAt||null, bridge:"Arcscan + Circle CCTP + destination nonces", lend:`Arc RPC ${new URL(rpc).hostname} block ${tip} (${rpcCandidates} candidates)` },
    arcpay:pay?.totals||{}, fx:fx||{}, bridge, treasury:treasury?{balances:treasury.balances,totals:treasury.totals,counts:treasury.counts}:null,
    market:{ launches:launches.length, graduated:launches.filter(x=>x.graduated).length, trades:trades.length, holders:launches.reduce((s,x)=>s+(x.holderCount||0),0), volumeUsd:launches.reduce((s,x)=>s+Number(x.volume||0)/1e18,0), recent:trades.slice(0,20) },
    lend:{ address:LEND, suppliedUsd:Number(formatEther(assets)), borrowedUsd:Number(formatEther(borrows)), liquidityUsd:Number(formatEther(assets))-Number(formatEther(borrows)), reserveRevenueUsd:Number(formatEther(reserves)), supplyCapUsd:Number(formatEther(supplyCap)), borrowCapUsd:Number(formatEther(borrowCap)), utilizationPct:Number(assets)>0?Number(borrows)*100/Number(assets):0, pauseFlags:Number(pauseFlags), badDebtUsd:Number(formatEther(badDebt)), oracleAgeSeconds:Math.max(0,Math.floor(Date.now()/1000)-Number(lastGoodPriceAt)), needsAttention:Number(pauseFlags)>0||Number(badDebt)>0||Math.floor(Date.now()/1000)-Number(lastGoodPriceAt)>3600 },
    revenue:{ arcpayUsd:pay?.totals?.protocolFeesUsd||0, fxUsd:fx?.protocolFeesUsd||0, lendUsd:Number(formatEther(reserves)), note:"Verified protocol accounting only; bridge and market fees are excluded until directly indexed." }
  };
  mkdirSync(dirname(OUT),{recursive:true}); writeFileSync(OUT,JSON.stringify(payload,null,2)); console.log(`Unified analytics written: ${OUT}`); await provider.destroy();
}
main().catch((e)=>{console.error(e);process.exit(1)});

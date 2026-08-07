import {useEffect,useMemo,useState} from "react";import {BrowserProvider,Contract,parseEther,parseUnits} from "ethers";import {ARC,ARC_MAINNET} from "../config";import {TREASURY_ADDRESS,TREASURY_TRANSFER_CAP_USD,validateTreasuryTransfer} from "../treasurySafety";import {describeTxError} from "../txError";import "./Treasury.css";
type Entry={tx:string;timestamp:number;direction:"in"|"out";token:string;amount:number;from:string;to:string;category:string;source:string};type Feed={treasury:string;indexedAt:string;indexedBlock:number;balances:{nativeUsdc:number;usdcErc20:number;eurc?:number};totals:{inUsd:number;outUsd:number;revenueUsd:number;unknownUsd:number};counts:{transactions:number;inbound:number;outbound:number;attributed:number};alerts?:Array<{level:string;message:string;tx:string}>;entries:Entry[]};type Props={account:string;chainId:number|null;activeProvider:EthereumProvider|null;connect:()=>void};
const usd=(n:number)=>`$${Number(n||0).toLocaleString(undefined,{maximumFractionDigits:6})}`,short=(v:string)=>`${v.slice(0,6)}…${v.slice(-4)}`;

const PAGE_SIZE=20;
function NetworkLedger({feed,explorer,filter,setFilter,exportCsv}:{feed:Feed;explorer:string;filter:string;setFilter:(v:string)=>void;exportCsv:()=>void}){
  const [visible,setVisible]=useState(PAGE_SIZE);
  const all=useMemo(()=>feed.entries.filter(x=>filter==="all"||x.category.toLowerCase()===filter),[feed,filter]);
  const rows=all.slice(0,visible);
  useEffect(()=>{setVisible(PAGE_SIZE)},[filter]);
  const age=Math.floor((Date.now()-Date.parse(feed.indexedAt))/60000);
  return <>
    <div className="treasury-status"><b>{age<20?"LIVE":"STALE"}</b><small>Block {feed.indexedBlock.toLocaleString()} · {age} min ago</small><button onClick={exportCsv}>Export CSV</button></div>
    <div className="treasury-balances"><article><small>USDC BALANCE</small><strong>{usd(feed.balances.nativeUsdc)}</strong></article><article><small>ERC-20 VIEW · SAME USDC</small><strong>{usd(feed.balances.usdcErc20)}</strong></article>{feed.balances.eurc!==undefined&&<article><small>EURC</small><strong>{usd(feed.balances.eurc)}</strong></article>}<article><small>ATTRIBUTED INFLOW</small><strong>{usd(feed.totals.revenueUsd)}</strong></article></div>
    {feed.alerts&&feed.alerts.length>0&&<aside className="treasury-alerts"><b>Needs attention</b>{feed.alerts.map(a=><a key={a.tx+a.message} href={`${explorer}/tx/${a.tx}`} target="_blank" rel="noreferrer">{a.message} ↗</a>)}</aside>}
    <section className="treasury-summary"><article><b>{feed.counts.transactions}</b><span>Indexed transfers</span></article><article><b>{usd(feed.totals.inUsd)}</b><span>Total inflow</span></article><article><b>{usd(feed.totals.outUsd)}</b><span>Total outflow</span></article><article><b>{usd(feed.totals.unknownUsd)}</b><span>Unattributed</span></article></section>
    <div className="treasury-ledger"><header><div><p>ONCHAIN LEDGER</p><h2>Token transfers</h2></div><nav>{["all","revenue","operational","unknown"].map(x=><button className={filter===x?"active":""} onClick={()=>setFilter(x)} key={x}>{x}</button>)}</nav></header>
      {rows.length===0&&<p className="treasury-empty">No transfers in this category yet.</p>}
      {rows.map(row=><article key={row.tx+row.token+row.amount}><span className={row.direction}>{row.direction==="in"?"+":"−"} {row.amount.toLocaleString()} {row.token}</span><div><b>{row.source}</b><small>{row.category} · {new Date(row.timestamp*1000).toLocaleString()}</small></div><code>{short(row.direction==="in"?row.from:row.to)}</code><a href={`${explorer}/tx/${row.tx}`} target="_blank" rel="noreferrer">Evidence ↗</a></article>)}
      {visible<all.length&&<button className="ledger-more" onClick={()=>setVisible(v=>v+PAGE_SIZE)}>Show {Math.min(PAGE_SIZE,all.length-visible)} more ({all.length-visible} left · or Export CSV above for all {all.length})</button>}
    </div>
  </>;
}

export default function Treasury({account,chainId,activeProvider,connect}:Props){
  const [mainnet,setMainnet]=useState<Feed|null>(null),[testnet,setTestnet]=useState<Feed|null>(null);
  const [mainnetFilter,setMainnetFilter]=useState("all"),[testnetFilter,setTestnetFilter]=useState("all");
  const [recipient,setRecipient]=useState(""),[amount,setAmount]=useState(""),[token,setToken]=useState<"USDC"|"EURC">("USDC"),[review,setReview]=useState(false),[phrase,setPhrase]=useState(""),[status,setStatus]=useState(""),[busy,setBusy]=useState(false);
  const refresh=()=>{fetch("/data/treasury-mainnet.json",{cache:"no-store"}).then(r=>r.ok?r.json():null).then(setMainnet).catch(()=>{});fetch("/data/treasury.json",{cache:"no-store"}).then(r=>r.ok?r.json():null).then(setTestnet).catch(()=>{})};
  useEffect(()=>{void refresh()},[]);
  const isMainnetWallet=chainId===ARC_MAINNET.id,activeArc=isMainnetWallet?ARC_MAINNET:ARC;
  const validation=validateTreasuryTransfer(recipient,amount),isTreasury=account.toLowerCase()===TREASURY_ADDRESS.toLowerCase();
  useEffect(()=>{if(isMainnetWallet&&token==="EURC")setToken("USDC")},[isMainnetWallet,token]);

  function exportCsv(feed:Feed|null,name:string){if(!feed)return;const csv=["timestamp,direction,token,amount,category,source,from,to,tx",...feed.entries.map(x=>[new Date(x.timestamp*1000).toISOString(),x.direction,x.token,x.amount,x.category,x.source,x.from,x.to,x.tx].join(","))].join("\n"),a=document.createElement("a");a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));a.download=name;a.click();URL.revokeObjectURL(a.href)}
  async function switchNetwork(target:typeof ARC|typeof ARC_MAINNET){if(!activeProvider)return connect();await activeProvider.request({method:"wallet_switchEthereumChain",params:[{chainId:target.hexId}]})}
  async function execute(){
    if(!activeProvider||!isTreasury||!validation.ok||phrase!==validation.confirmation)return;
    setBusy(true);setStatus("Waiting for treasury wallet signature…");
    try{
      if(chainId!==ARC.id&&chainId!==ARC_MAINNET.id){await switchNetwork(ARC_MAINNET);throw Error("Network switched. Review once more before signing.")}
      const signer=await new BrowserProvider(activeProvider).getSigner();
      const tx=token==="USDC"
        ?await signer.sendTransaction({to:validation.address,value:parseEther(amount)})
        :await new Contract("0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",["function transfer(address,uint256) returns(bool)"],signer).transfer(validation.address,parseUnits(amount,6));
      setStatus(`Submitted ${tx.hash.slice(0,12)}…`);await tx.wait();setStatus(`Confirmed on ${activeArc.name}: ${tx.hash}`);
      setReview(false);setRecipient("");setAmount("");setPhrase("");setTimeout(()=>void refresh(),6000);
    }catch(e){setStatus(describeTxError(e))}finally{setBusy(false)}
  }

  if(!mainnet&&!testnet)return <section className="treasury"><p>Loading treasury ledger…</p></section>;
  return <section className="treasury">
    <header><p>TREASURY LITE</p><h1>Public funds.<br/>Public evidence.</h1><span>Canonical treasury {TREASURY_ADDRESS} — the same wallet on every network. Unknown transfers remain explicitly unattributed rather than guessed at.</span></header>

    <section className="treasury-network">
      <div className="treasury-network-head"><span className="tag-mainnet">ARC MAINNET · REAL VALUE</span><h2>Where the money actually is</h2></div>
      {mainnet?<NetworkLedger feed={mainnet} explorer={ARC_MAINNET.explorer} filter={mainnetFilter} setFilter={setMainnetFilter} exportCsv={()=>exportCsv(mainnet,"arcodian-treasury-mainnet.csv")}/>:<p className="treasury-empty">Mainnet indexer hasn't reported yet — check back shortly.</p>}
    </section>

    <details className="treasury-network treasury-legacy">
      <summary><span className="tag-testnet">ARC TESTNET · NO FINANCIAL VALUE</span><h2>Legacy testnet activity</h2><small>Kept for historical continuity — none of this ever had real value. Click to expand.</small></summary>
      {testnet?<NetworkLedger feed={testnet} explorer={ARC.explorer} filter={testnetFilter} setFilter={setTestnetFilter} exportCsv={()=>exportCsv(testnet,"arcodian-treasury-testnet.csv")}/>:<p className="treasury-empty">Testnet indexer hasn't reported yet.</p>}
    </details>

    <section className="treasury-transfer">
      <p>SAFE TRANSFER · WALLET SIGNED</p><h2>Treasury execution</h2>
      {!account?<><span>Connect the canonical treasury wallet. The server cannot sign.</span><button onClick={connect}>Connect treasury wallet</button></>
      :!isTreasury?<div className="transfer-blocked"><b>Read-only wallet</b><span>Connected {short(account)} is not the canonical treasury.</span></div>
      :<>
        <div className="transfer-fields">
          <label>Asset<select value={token} onChange={e=>setToken(e.target.value as "USDC"|"EURC")}><option>USDC</option>{!isMainnetWallet&&<option>EURC</option>}</select></label>
          <label>Recipient<input value={recipient} onChange={e=>{setRecipient(e.target.value);setReview(false)}} placeholder="0x…"/></label>
          <label>Amount<input inputMode="decimal" value={amount} onChange={e=>{setAmount(e.target.value);setReview(false)}} placeholder="0.00"/></label>
        </div>
        <small>Policy cap: {TREASURY_TRANSFER_CAP_USD} per transaction · executes on whichever network your wallet is currently connected to ({activeArc.name}).</small>
        {!review?<button disabled={!validation.ok} onClick={()=>{setReview(true);setPhrase("")}}>Review transfer</button>:
          <div className="transfer-review">
            <b>Final review</b>
            <dl><div><dt>Asset</dt><dd>{amount} {token}</dd></div><div><dt>Recipient</dt><dd>{validation.address}</dd></div><div><dt>Network</dt><dd>{activeArc.name}{isMainnetWallet&&<b className="real-value-badge"> · REAL VALUE</b>}</dd></div></dl>
            <label>Type recipient suffix <code>{validation.confirmation}</code><input value={phrase} onChange={e=>setPhrase(e.target.value.toUpperCase())}/></label>
            <div><button onClick={()=>setReview(false)}>Cancel</button><button disabled={busy||phrase!==validation.confirmation} onClick={()=>void execute()}>{busy?"Confirming…":(chainId===ARC.id||chainId===ARC_MAINNET.id)?`Sign in treasury wallet (${activeArc.name})`:"Switch to Arc Mainnet"}</button></div>
          </div>}
        {!validation.ok&&recipient&&<small className="transfer-error">{validation.error}</small>}
      </>}
      {status&&<p className="transfer-status">{status}</p>}
    </section>

    <footer><span>Self-custodial: this page prepares transactions; the treasury wallet signs them.</span><a href={`${ARC_MAINNET.explorer}/address/${TREASURY_ADDRESS}`} target="_blank" rel="noreferrer">Open treasury on Arc Mainnet explorer ↗</a></footer>
  </section>;
}

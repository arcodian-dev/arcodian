import {useEffect,useState} from "react";import {BrowserProvider,parseEther} from "ethers";import {ARC_MAINNET} from "../config";import {TREASURY_ADDRESS,TREASURY_TRANSFER_CAP_USD,validateTreasuryTransfer} from "../treasurySafety";import {describeTxError} from "../txError";import "./Treasury.css";
type Feed={treasury:string;indexedAt:string;indexedBlock:number;balances:{nativeUsdc:number;usdcErc20:number};totals:{inUsd:number;outUsd:number;revenueUsd:number;unknownUsd:number};counts:{transactions:number};alerts?:Array<{level:string;message:string;tx:string}>};
type Props={account:string;chainId:number|null;activeProvider:EthereumProvider|null;connect:()=>void};
const usd=(n:number)=>`$${Number(n||0).toLocaleString(undefined,{maximumFractionDigits:6})}`,short=(v:string)=>`${v.slice(0,6)}…${v.slice(-4)}`;

function Seal({live}:{live:boolean}){
  return <svg className="vault-seal-ring" viewBox="0 0 200 200" width="220" height="220" aria-hidden="true">
    <circle cx="100" cy="100" r="94" className="seal-outer"/>
    <circle cx="100" cy="100" r="80" className="seal-inner"/>
    {Array.from({length:36}).map((_,i)=>{const a=(i/36)*Math.PI*2,x1=100+Math.cos(a)*88,y1=100+Math.sin(a)*88,x2=100+Math.cos(a)*94,y2=100+Math.sin(a)*94;return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} className="seal-tick"/>})}
    {live&&<circle cx="100" cy="12" r="4" className="seal-pulse"/>}
  </svg>;
}

export default function Treasury({account,chainId,activeProvider,connect}:Props){
  const [feed,setFeed]=useState<Feed|null>(null);
  const [recipient,setRecipient]=useState(""),[amount,setAmount]=useState(""),[review,setReview]=useState(false),[phrase,setPhrase]=useState(""),[status,setStatus]=useState(""),[busy,setBusy]=useState(false);
  const refresh=()=>{fetch("/data/treasury-mainnet.json",{cache:"no-store"}).then(r=>r.ok?r.json():null).then(setFeed).catch(()=>{})};
  useEffect(()=>{void refresh()},[]);
  const isMainnetWallet=chainId===ARC_MAINNET.id;
  const validation=validateTreasuryTransfer(recipient,amount),isTreasury=account.toLowerCase()===TREASURY_ADDRESS.toLowerCase();

  async function switchToMainnet(){if(!activeProvider)return connect();await activeProvider.request({method:"wallet_switchEthereumChain",params:[{chainId:ARC_MAINNET.hexId}]})}
  async function execute(){
    if(!activeProvider||!isTreasury||!validation.ok||phrase!==validation.confirmation)return;
    setBusy(true);setStatus("Waiting for treasury wallet signature…");
    try{
      if(chainId!==ARC_MAINNET.id){await switchToMainnet();throw Error("Network switched. Review once more before signing.")}
      const signer=await new BrowserProvider(activeProvider).getSigner();
      const tx=await signer.sendTransaction({to:validation.address,value:parseEther(amount)});
      setStatus(`Submitted ${tx.hash.slice(0,12)}…`);await tx.wait();setStatus(`Confirmed: ${tx.hash}`);
      setReview(false);setRecipient("");setAmount("");setPhrase("");setTimeout(()=>void refresh(),6000);
    }catch(e){setStatus(describeTxError(e))}finally{setBusy(false)}
  }

  if(!feed)return <section className="treasury"><p className="treasury-loading">Reading the vault…</p></section>;
  const age=Math.floor((Date.now()-Date.parse(feed.indexedAt))/60000),live=age<20;

  return <section className="treasury">
    <header><p>TREASURY LITE</p><h1>Public funds.<br/>Public evidence.</h1><span>The canonical Arcodian treasury holds real value on Arc Mainnet. This page reads it live — nothing here is a claim you have to take our word for.</span></header>

    <section className="vault">
      <div className="vault-seal">
        <Seal live={live}/>
        <div className="vault-reading"><strong>{usd(feed.balances.nativeUsdc)}</strong><small>USDC · Arc Mainnet</small></div>
      </div>
      <div className="vault-meta">
        <span className={`vault-pulse ${live?"live":"stale"}`}>{live?"● LIVE":"○ STALE"}<small>Block {feed.indexedBlock.toLocaleString()} · {age} min ago</small></span>
        <a href={`${ARC_MAINNET.explorer}/address/${TREASURY_ADDRESS}`} target="_blank" rel="noreferrer">Verify independently on Arc Mainnet ↗</a>
      </div>
      {feed.alerts&&feed.alerts.length>0&&<aside className="treasury-alerts"><b>Needs attention</b>{feed.alerts.slice(0,3).map(a=><a key={a.tx+a.message} href={`${ARC_MAINNET.explorer}/tx/${a.tx}`} target="_blank" rel="noreferrer">{a.message} ↗</a>)}</aside>}
    </section>

    <section className="vault-stats">
      <article><b>{usd(feed.totals.revenueUsd)}</b><span>Attributed protocol revenue</span></article>
      <article><b>{feed.counts.transactions}</b><span>Transfers indexed</span></article>
      <article><b className="mono">{short(TREASURY_ADDRESS)}</b><span>Canonical treasury</span></article>
    </section>

    <section className="treasury-transfer">
      <p>SAFE TRANSFER · WALLET SIGNED</p><h2>Move funds</h2>
      {!account?<button onClick={connect}>Connect treasury wallet</button>
      :!isTreasury?<div className="transfer-blocked"><b>Read-only wallet</b><span>Connected {short(account)} is not the canonical treasury.</span></div>
      :<>
        <div className="transfer-fields">
          <label>Recipient<input value={recipient} onChange={e=>{setRecipient(e.target.value);setReview(false)}} placeholder="0x…"/></label>
          <label>Amount<input inputMode="decimal" value={amount} onChange={e=>{setAmount(e.target.value);setReview(false)}} placeholder="0.00"/></label>
        </div>
        <small>Policy cap: {TREASURY_TRANSFER_CAP_USD} USDC per transfer, Arc Mainnet only.</small>
        {!review?<button disabled={!validation.ok} onClick={()=>{setReview(true);setPhrase("")}}>Review transfer</button>:
          <div className="transfer-review">
            <b>Final review</b>
            <dl><div><dt>Amount</dt><dd>{amount} USDC</dd></div><div><dt>Recipient</dt><dd>{validation.address}</dd></div><div><dt>Network</dt><dd>Arc Mainnet</dd></div></dl>
            <label>Type recipient suffix <code>{validation.confirmation}</code><input value={phrase} onChange={e=>setPhrase(e.target.value.toUpperCase())}/></label>
            <div><button onClick={()=>setReview(false)}>Cancel</button><button disabled={busy||phrase!==validation.confirmation} onClick={()=>void execute()}>{busy?"Confirming…":isMainnetWallet?"Sign in treasury wallet":"Switch to Arc Mainnet"}</button></div>
          </div>}
        {!validation.ok&&recipient&&<small className="transfer-error">{validation.error}</small>}
      </>}
      {status&&<p className="transfer-status">{status}</p>}
    </section>

    <footer><span>Self-custodial — this page prepares transactions; the treasury wallet signs them.</span><a href={`${ARC_MAINNET.explorer}/address/${TREASURY_ADDRESS}`} target="_blank" rel="noreferrer">Open on Arc Mainnet explorer ↗</a></footer>
  </section>;
}

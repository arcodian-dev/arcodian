import { useState } from "react";
import "./Developers.css";

const REGISTRY="/developers/contracts.json";
const SDK="/agentpay-sdk.mjs";
const agentCode=`import { JsonRpcProvider, Wallet } from "ethers";
import { inspectPolicy, payBoundedInvoice } from "https://arcodian.fun/agentpay-sdk.mjs";

const provider = new JsonRpcProvider(process.env.ARC_RPC_URL);
const signer = new Wallet(process.env.AGENT_PRIVATE_KEY, provider); // server/HSM only
const policy = await inspectPolicy(provider, process.env.VAULT, signer.address, process.env.MERCHANT);
if (!policy.enabled || !policy.allowed) throw new Error("Policy or merchant permission denied");
const tx = await payBoundedInvoice(signer, { vault: process.env.VAULT, merchant: process.env.MERCHANT,
  amount: "0.10", invoiceId: "order-123", expiresIn: 900, memo: "service payment" });
console.log(tx.hash);`;
const verifyCode=`curl -s https://arcodian.fun/developers/contracts.json | jq .contracts
cast chain-id --rpc-url https://rpc.testnet.arc.network/
cast call 0x27c722F643ea787f7425449AF8B03601B90815eD 'arcPay()(address)' --rpc-url https://rpc.testnet.arc.network/
cast call 0x571493d389862c2AF13985357b11916E5E54365d 'admin()(address)' --rpc-url https://rpc.testnet.arc.network/`;
const entries=[
 ["Arc Pay","0x5E3d1B63213B8608539116D1C6248A36819684b5","Exact-value invoices, 30 bps merchant fee, one-use invoice IDs, merchant refund."],
 ["Agent Pay Factory","0x27c722F643ea787f7425449AF8B03601B90815eD","One isolated non-custodial vault per owner; no factory admin path into user funds."],
 ["ArcLend v2 · utilization rate","0x571493d389862c2AF13985357b11916E5E54365d","Timelocked EURC-collateral market, separate emergency guardian, delayed cap increases, and a Compound/Aave-style utilization interest curve."],
 ["Governance multisig","0x4EA32e81a277aECE213602eA757a5ca3144Aa3aa","2-of-2 testnet governance canary controlling the 24-hour timelock."],
 ["Stablecoin FX","0x982D61ddCAb6169d82B3e37A4E4158f1982E5447","Permissionless USDC/EURC AMM with 8 bps LP + 2 bps protocol fee."],
 ["Agent Passport · ERC-8004","0xDaCEF31ca7C5B1cebB5516f541cfF05E17eC2cCf","Binds an Agent ID to an authorized wallet with owner-only rotation; identity alone never grants spend."],
 ["Agent Jobs v2","0x33f54C516107A8c67d9Dc245f00E253132a6D15A","Escrowed USDC job lifecycle; a nonzero provider Agent ID is accepted only from the current Passport wallet."],
 ["Session-Key Account · F4","0x06e26288AeC908c926A8e2466d9543e997f59d7C","Scoped session key executes autonomously within target, function, per-call/daily caps, and time window — enforced on-chain, owner keeps custody. Spike."],
 ["Admin Timelock · F5","0xefd956531dc0585d412d6fa4afcb8d940aa2b4ac","Governed administration: schedule → enforced delay → execute, with cancel and a self-governed delay. Spike."],
] as const;

export default function Developers(){
 const [copied,setCopied]=useState(""); const copy=async(name:string,value:string)=>{await navigator.clipboard.writeText(value);setCopied(name);setTimeout(()=>setCopied(""),1200)};
 return <main className="developers">
  <header className="dev-hero"><div className="dev-hero-copy"><p>ARCODIAN / BUILD SYSTEMS / 5042002</p><h1>Money rails for<br/><em>machines with limits.</em></h1><span>Compose exact-value payments, isolated agent vaults, and governed credit without giving software an unrestricted wallet.</span><nav><a className="dev-primary" href={SDK}>Open Agent Pay SDK ↗</a><a href="/docs">Read the protocol</a></nav></div><aside aria-label="Deployment status"><small>PUBLIC TESTNET</small><strong>05</strong><span>canonical surfaces</span><hr/><b>3 / 3 governed contracts verified</b><i>RPC transport failover active</i></aside></header>
  <details className="dev-resources"><summary><span><b>Build resources</b><small>Machine-readable registry, schemas, migration state, and SDK</small></span><i>Open technical drawer +</i></summary><div><a href={REGISTRY}><b>contracts.json</b><small>Canonical addresses + verification</small></a><a href="/developers/events.json"><b>events.json</b><small>Indexer event schemas</small></a><a href="/developers/agents.json"><b>agents.json</b><small>Indexed Agent Passport registry</small></a><a href="/developers/jobs.json"><b>jobs.json</b><small>Indexed Agent Jobs feed</small></a><a href="/developers/reputation.json"><b>reputation.json</b><small>Objective reputation + validation tiers</small></a><a href="/developers/verification-status.json"><b>verification-status.json</b><small>Per-contract source-verification state</small></a><a href="https://arcodian.fun/mcp"><b>MCP endpoint</b><small>Read + unsigned builders · never signs</small></a><a href={SDK}><b>agentpay-sdk.mjs</b><small>Signer-bound integration module</small></a></div></details>
  <section className="dev-quick"><p>SIGNER TOPOLOGY</p><h2>Three roles. No shared authority.</h2><div><article><i>01</i><b>Owner / policy</b><span>Funds one isolated vault, then defines caps, expiry, and merchant permissions.</span></article><article><i>02</i><b>Agent / execution</b><span>Inspects policy and pays one permitted invoice. It cannot configure or withdraw.</span></article><article><i>03</i><b>Merchant / settlement</b><span>Receives Arc Pay settlement and may return the exact gross amount once.</span></article></div></section>
  <section className="dev-registry"><header><p>CANONICAL REGISTRY</p><h2>Verify before integrating.</h2></header>{entries.map(([name,address,note])=><article key={address}><div><b>{name}</b><span>{note}</span></div><code>{address}</code><button onClick={()=>copy(name,address)}>{copied===name?"Copied":"Copy"}</button><a href={`https://testnet.arcscan.app/address/${address}`} target="_blank" rel="noreferrer">Arcscan ↗</a></article>)}</section>
  <section className="dev-code"><article><p>AGENT PAY · NODE/ETHERS</p><h2>Inspect, then pay.</h2><pre><code>{agentCode}</code></pre><button onClick={()=>copy("agent",agentCode)}>{copied==="agent"?"Copied":"Copy example"}</button></article><article><p>VERIFY DEPLOYMENT</p><h2>Trust chain state, not prose.</h2><pre><code>{verifyCode}</code></pre><button onClick={()=>copy("verify",verifyCode)}>{copied==="verify"?"Copied":"Copy commands"}</button></article></section>
  <section className="dev-guardrails"><p>INTEGRATION RULES</p><h2>Fail closed.</h2><ul><li>Never place a private key, mnemonic, or unrestricted API key in browser code.</li><li>Read policy, merchant allowlist, expiry, daily usage, and vault balance before requesting a signature.</li><li>Use a unique invoice ID and a short expiry; treat receipt-polling 429 as unknown, then verify tx/state before retrying.</li><li>Refunds do not restore Agent Pay daily allowance, preventing spend-limit recycling.</li><li>Arc uses native USDC at 18 decimals for value/gas; its ERC-20 interface and EURC use 6 decimals.</li></ul></section>
  <footer><span>Testnet only · contracts are unaudited production candidates.</span><a href="/contracts">Trust Center →</a></footer>
 </main>
}

import { useEffect, useState } from "react";
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
const verifyCode=`# Arc Mainnet (5042) — real value
cast chain-id --rpc-url https://arcodian.fun/api/rpc-mainnet.php
cast call 0x508FDa9F366E734a45fE7bc3a98F2909754633B7 'launchCount()(uint256)' --rpc-url https://arcodian.fun/api/rpc-mainnet.php

# Arc Testnet (5042002) — agent economy, no financial value
curl -s https://arcodian.fun/developers/contracts.json | jq .contracts
cast chain-id --rpc-url https://rpc.testnet.arc.network/
cast call 0x27c722F643ea787f7425449AF8B03601B90815eD 'arcPay()(address)' --rpc-url https://rpc.testnet.arc.network/`;
const entries=[
 ["Arc Pay","0x5E3d1B63213B8608539116D1C6248A36819684b5","Exact-value invoices, 30 bps merchant fee, one-use invoice IDs, merchant refund."],
 ["Agent Pay Factory","0x27c722F643ea787f7425449AF8B03601B90815eD","One isolated non-custodial vault per owner; no factory admin path into user funds."],
 ["ArcLend v2 · utilization rate","0x571493d389862c2AF13985357b11916E5E54365d","Timelocked EURC-collateral market, separate emergency guardian, delayed cap increases, and a Compound/Aave-style utilization interest curve."],
 ["Governance multisig","0x4EA32e81a277aECE213602eA757a5ca3144Aa3aa","2-of-2 testnet governance canary controlling the 24-hour timelock."],
 ["Stablecoin FX","0x982D61ddCAb6169d82B3e37A4E4158f1982E5447","Permissionless USDC/EURC AMM with 8 bps LP + 2 bps protocol fee."],
 ["Agent Passport · ERC-8004","0xDaCEF31ca7C5B1cebB5516f541cfF05E17eC2cCf","Binds an Agent ID to an authorized wallet with owner-only rotation; identity alone never grants spend."],
 ["Agent Pay Factory v4","0x8F4Ba684C7c294DF3Af50AC023975F6695CA4299","Identity-aware vault template; a policy for an agentId goes inert the instant that agentId's Identity Registry ownership changes, not just when the passport wallet rotates."],
 ["Agent Pay Factory v6 · testnet","0xBb998B06C4E5028ddF70af669920e20141a2f662","ERC-1271-aware vault template with atomic EIP-712 batch payments, one nonce per batch, and a 16-invoice maximum. Additive testnet integration."],
 ["Agent Jobs v2 (self-dealing fixed)","0xfFdb3EC041DC1Cad062F0F80FF1a6F8292f21Df2","Escrowed USDC job lifecycle; a nonzero provider Agent ID is accepted only from the current Passport wallet; evaluator can no longer be the client or provider."],
 ["Session-Key Account · F4","0x06e26288AeC908c926A8e2466d9543e997f59d7C","Scoped session key executes autonomously within target, function, per-call/daily caps, and time window — enforced on-chain, owner keeps custody. Spike."],
 ["Admin Timelock · F5","0x8baC8017081134f02065fFefa340837278C03052","Governed administration: schedule → enforced delay → execute, with cancel, a self-governed delay, and a two-step admin handoff. Spike."],
] as const;

// Live on Arc Mainnet (chain 5042), real USDC — deployed 2026-07-30/31, all
// source-verified on arc.exploreme.pro. This page defaulted to reading as
// testnet-only (hero badge, chain id, registry below) with mainnet only one
// link inside a collapsed drawer — easy to mistake for "still testnet" at a
// glance, which is exactly the confusion this section exists to prevent.
const mainnetEntries=[
 ["USDC-only Market Factory","0x508FDa9F366E734a45fE7bc3a98F2909754633B7","Launch/bonding-curve factory. Live with real launches from independent wallets — see ARCD, the first."],
 ["Market Graduation Hub","0xe98FF8c9825517eaC8A1CE2d00590D322AC4303F","Seals graduation authority into the mainnet pair factory below."],
 ["Market Pair Factory (Arcodian DEX)","0xadb7d3d229F78198c4dE827607c89F95E9cE7722","Permissionless AMM registry — the same pool a graduated Market coin trades on, and the pool Swap/Pools/Create pool now read directly."],
 ["Arcodian DEX Router","0x4A5eF82818F674452690539D75517b4604981Bed","Stateless multi-hop swap router over the pair factory above. Holds no funds between transactions."],
 ["Arc Pay (mainnet)","0x1dE9822D79aFdd53f9270503d16080F9ecbFdB7C","Exact-value invoice settlement, deployed to Arc Mainnet."],
 ["Agent Pay Factory (mainnet)","0x4E3fDc7ddA063e8d629C7140e1D7ace574275c69","Non-identity vault template, mainnet deployment."],
 ["Agent Pay Factory v6 (mainnet)","0x69d7eE9672fE5b7660B6a13D3B6f767C7E8576dB","Additive ERC-1271-aware batch-payment factory. No automatic vault creation and not yet routed by the production UI."],
 ["Admin Timelock (mainnet)","0xba953bc1282d0bffe22b4f769822d20900625594","Governed administration for the mainnet contracts above."],
 ["Session-Key Account (mainnet)","0x1602ee1fb997c75a7cf199f3adeba5b990edd06b","Scoped session-key executor, mainnet deployment."],
 ["ArcBridgeRouter · Arc","0xC35deB937F5056a0e034f10e21094878485CaeE7","1.5% fee router over Circle's official CCTP v2 rails. Same contract also verified on Ethereum, Optimism, Arbitrum, and Base."],
] as const;

type VerificationStatus={counts?:{verified?:number;unverified?:number};contracts?:Array<{verification:string}>};

export default function Developers(){
 const [copied,setCopied]=useState(""); const copy=async(name:string,value:string)=>{await navigator.clipboard.writeText(value);setCopied(name);setTimeout(()=>setCopied(""),1200)};
 // Pulled live rather than hardcoded — a stale "3/3 verified" string here
 // would be exactly the kind of self-defeating bug this page exists to catch
 // (see TrustCenter's own wiring-proof self-check, which had the same class
 // of staleness bug from an earlier threshold migration).
 const [verification,setVerification]=useState<VerificationStatus|null>(null);
 useEffect(()=>{fetch("/developers/verification-status.json",{cache:"no-store"}).then(r=>r.ok?r.json():null).then(setVerification).catch(()=>setVerification(null))},[]);
 const totalContracts=verification?.contracts?.length;
 const verifiedCount=verification?.counts?.verified;
 return <main className="developers">
  <header className="dev-hero"><div className="dev-hero-copy"><p>ARCODIAN / BUILD SYSTEMS / TWO NETWORKS</p><h1>Money rails for<br/><em>machines with limits.</em></h1><span>Compose exact-value payments, isolated agent vaults, and governed credit without giving software an unrestricted wallet. Bridge and the USDC-only Market run on Arc Mainnet (5042) with real value; the agent-economy stack below is Arc Testnet (5042002).</span><nav><a className="dev-primary" href={SDK}>Open Agent Pay SDK ↗</a><a href="/docs">Read the protocol</a></nav></div><aside aria-label="Deployment status" className="dev-status-split"><div><small>ARC MAINNET · 5042</small><strong>{mainnetEntries.length}</strong><span>contracts, all source-verified</span></div><div><small>ARC TESTNET · 5042002</small><strong>{entries.length}</strong><span>canonical surfaces</span></div><hr/><b>{verifiedCount!==undefined&&totalContracts!==undefined?`${verifiedCount} / ${totalContracts} testnet contracts verified`:"Checking verification…"}</b><i>RPC transport failover active</i></aside></header>
  <details className="dev-resources"><summary><span><b>Build resources</b><small>Machine-readable registry, schemas, migration state, and SDK</small></span><i>Open technical drawer +</i></summary><div><a href={REGISTRY}><b>contracts.json</b><small>Canonical Arc Testnet addresses + verification</small></a><a href="/developers/contracts.mainnet.json"><b>contracts.mainnet.json</b><small>Arc Mainnet — Bridge + USDC-only Market, real value</small></a><a href="/developers/mainnet-readiness.json"><b>mainnet-readiness.json</b><small>Gate-by-gate mainnet readiness report</small></a><a href="/developers/events.json"><b>events.json</b><small>Indexer event schemas</small></a><a href="/developers/agents.json"><b>agents.json</b><small>Indexed Agent Passport registry</small></a><a href="/developers/jobs.json"><b>jobs.json</b><small>Indexed Agent Jobs feed</small></a><a href="/developers/reputation.json"><b>reputation.json</b><small>Objective reputation + validation tiers</small></a><a href="/developers/verification-status.json"><b>verification-status.json</b><small>Per-contract source-verification state</small></a><a href="https://arcodian.fun/mcp"><b>MCP endpoint</b><small>Read + unsigned builders · never signs</small></a><a href={SDK}><b>agentpay-sdk.mjs</b><small>Signer-bound integration module</small></a></div></details>
  <section className="dev-registry dev-registry-mainnet"><header><p>ARC MAINNET · REAL VALUE</p><h2>Deployed and source-verified, chain 5042.</h2><span>Bridge (CCTP) and the USDC-only Market/Launchpad move real USDC. Governance on these is still deployer-only — no mainnet multisig yet.</span></header>{mainnetEntries.map(([name,address,note])=><article key={address}><div><b>{name}</b><span>{note}</span></div><code>{address}</code><button onClick={()=>copy(name,address)}>{copied===name?"Copied":"Copy"}</button><a href={`https://arc.exploreme.pro/address/${address}`} target="_blank" rel="noreferrer">Explorer ↗</a></article>)}</section>
  <section className="dev-quick"><p>SIGNER TOPOLOGY</p><h2>Three roles. No shared authority.</h2><div><article><i>01</i><b>Owner / policy</b><span>Funds one isolated vault, then defines caps, expiry, and merchant permissions.</span></article><article><i>02</i><b>Agent / execution</b><span>Inspects policy and pays one permitted invoice. It cannot configure or withdraw.</span></article><article><i>03</i><b>Merchant / settlement</b><span>Receives Arc Pay settlement and may return the exact gross amount once.</span></article></div></section>
  <section className="dev-registry"><header><p>ARC TESTNET · AGENT ECONOMY</p><h2>Verify before integrating.</h2><span>Test USDC and test EURC here have no financial value — this is the spike/agent-economy stack, not the mainnet contracts above.</span></header>{entries.map(([name,address,note])=><article key={address}><div><b>{name}</b><span>{note}</span></div><code>{address}</code><button onClick={()=>copy(name,address)}>{copied===name?"Copied":"Copy"}</button><a href={`https://testnet.arcscan.app/address/${address}`} target="_blank" rel="noreferrer">Arcscan ↗</a></article>)}</section>
  <section className="dev-code"><article><p>AGENT PAY · NODE/ETHERS</p><h2>Inspect, then pay.</h2><pre><code>{agentCode}</code></pre><button onClick={()=>copy("agent",agentCode)}>{copied==="agent"?"Copied":"Copy example"}</button></article><article><p>VERIFY DEPLOYMENT</p><h2>Trust chain state, not prose.</h2><pre><code>{verifyCode}</code></pre><button onClick={()=>copy("verify",verifyCode)}>{copied==="verify"?"Copied":"Copy commands"}</button></article></section>
  <section className="dev-guardrails"><p>INTEGRATION RULES</p><h2>Fail closed.</h2><ul><li>Never place a private key, mnemonic, or unrestricted API key in browser code.</li><li>Read policy, merchant allowlist, expiry, daily usage, and vault balance before requesting a signature.</li><li>Use a unique invoice ID and a short expiry; treat receipt-polling 429 as unknown, then verify tx/state before retrying.</li><li>Refunds do not restore Agent Pay daily allowance, preventing spend-limit recycling.</li><li>Arc uses native USDC at 18 decimals for value/gas; its ERC-20 interface and EURC use 6 decimals.</li></ul></section>
  <footer><span>The agent-economy registry above is Arc Testnet · unaudited production candidates, with no financial value. Bridge and the USDC-only Market are the real-value surfaces, live on Arc Mainnet — see the registry near the top of this page.</span><a href="/contracts">Trust Center →</a></footer>
 </main>
}

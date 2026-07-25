import {Panel,Button,Stat,Row,PageHeader,Glow,Badge} from "../design";

/**
 * Landing rebuilt on the Arc Aurora design system (2026-07-25).
 *
 * Dark, luminous, airy: one focal glow + one primary action in the hero,
 * ruled rows instead of a card per item. Product-overview first; the live coin
 * radar lives on the Market tab. Copy stays grounded — Arc is testnet.
 */
export default function LandingExperience({ enterMarket, openTab }: {
  enterMarket: () => void;
  chooseCoin: (address: string) => void;
  openTab: (tab: string) => void;
}){
  const go=(t:string)=>t==="screener"?enterMarket():openTab(t);
  const features=[
    {k:"wallet",icon:"◈",title:"Wallet",blurb:"Non-custodial USDC/EURC accounts on Arc, native gas."},
    {k:"agentpay",icon:"◇",title:"Agent Pay",blurb:"Bounded, identity-scoped spending for autonomous agents (ERC-8004)."},
    {k:"swap",icon:"◆",title:"Swap & Bridge",blurb:"USDC⇄EURC AMM plus Circle CCTP bridge — fees stay on Arc."},
  ];
  const rails=[
    {k:"swap",title:"Swap",blurb:"Permissionless pairs, two fee tiers."},
    {k:"bridge",title:"Bridge",blurb:"Circle CCTP burn-and-mint, recover-by-hash."},
    {k:"screener",title:"Launchpad & Market",blurb:"Bonding-curve launches and a live coin radar."},
  ];
  return <div className="au-page"><div className="au-container" style={{position:"relative",paddingBottom:96}}>
    <section style={{position:"relative",paddingTop:40}}><Glow/>
      <PageHeader eyebrow="ARCODIAN · ON CIRCLE ARC" title="Your money. Your agents. Your limits." subtitle="A stablecoin-native home for people and their autonomous agents — spend, swap, bridge, and settle under contract-enforced limits.">
        <div style={{display:"flex",gap:12,marginTop:20,flexWrap:"wrap"}}>
          <Button variant="primary" onClick={()=>go("wallet")}>Open Wallet</Button>
          <Button variant="secondary" onClick={()=>go("agentpay")}>Explore Agent Pay</Button>
        </div>
      </PageHeader>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:16,marginTop:16}}>
        <Panel><Stat label="Network" value="Arc Testnet"/></Panel>
        <Panel><Stat label="Settlement" value="USDC / EURC"/></Panel>
        <Panel featured><Stat label="Agent Passport" value="Live"/><div style={{marginTop:8}}><Badge tone="pos">ERC-8004</Badge></div></Panel>
      </div>
    </section>

    <section style={{marginTop:96}}>
      <span className="au-eyebrow">WHAT IT IS</span>
      <h2 className="au-h2" style={{marginTop:8,marginBottom:8}}>Three surfaces, one account</h2>
      <div style={{marginTop:8}}>{features.map(f=>
        <Row key={f.k} onClick={()=>go(f.k)}>
          <span className="au-mono" style={{fontSize:24,color:"var(--au-cyan)"}}>{f.icon}</span>
          <div className="grow"><div className="au-h3">{f.title}</div><div className="au-sub" style={{fontSize:15}}>{f.blurb}</div></div>
          <span className="au-mono" style={{color:"var(--ink-mute)"}}>→</span>
        </Row>)}
      </div>
    </section>

    <section style={{marginTop:96}}>
      <Panel featured>
        <span className="au-eyebrow">AGENT ECONOMY · PHASE A LIVE</span>
        <h2 className="au-h2" style={{marginTop:10}}>Agents that pay, within limits you set</h2>
        <p className="au-sub" style={{marginTop:10,maxWidth:620}}>Every agent gets an official on-chain identity, bound to one authorized wallet with owner-only rotation. A bounded policy executes only for the wallet currently authorized under the expected Agent ID.</p>
        <div style={{display:"flex",gap:12,marginTop:18,flexWrap:"wrap"}}>
          <Button variant="primary" onClick={()=>go("agentpay")}>Register a passport</Button>
          <Button variant="tertiary" as="a" href="/agent/851812">View a live agent →</Button>
        </div>
      </Panel>
    </section>

    <section style={{marginTop:96}}>
      <span className="au-eyebrow">PRODUCTS</span>
      <h2 className="au-h2" style={{marginTop:8,marginBottom:8}}>Everything settles in stablecoins</h2>
      <div style={{marginTop:8}}>{rails.map(r=>
        <Row key={r.k} onClick={()=>go(r.k)}>
          <div className="grow"><div className="au-h3">{r.title}</div><div className="au-sub" style={{fontSize:15}}>{r.blurb}</div></div>
          <span className="au-mono" style={{color:"var(--ink-mute)"}}>→</span>
        </Row>)}
      </div>
    </section>

    <footer style={{marginTop:96,paddingTop:24,borderTop:"1px solid var(--hair)",color:"var(--ink-mute)",display:"flex",justifyContent:"space-between",gap:20,flexWrap:"wrap"}}>
      <span className="au-mono" style={{fontSize:12}}>Arcodian · Circle Arc Testnet · not production-ready</span>
      <a className="au-mono" style={{fontSize:12,color:"var(--au-cyan)",textDecoration:"none"}} href="/developers">Developers →</a>
    </footer>
  </div></div>;
}

import {useState} from "react";
import {Panel,Button,Stat,Table,Field,Tabs,Badge,PageHeader,Glow} from "../design";

export default function KitchenSink(){
  const [tab,setTab]=useState<"a"|"b">("a");const [v,setV]=useState("");
  return <div className="au-page"><div className="au-container" style={{position:"relative",paddingBottom:96}}>
    <div style={{position:"relative"}}><Glow/>
      <PageHeader eyebrow="ARC AURORA · KITCHEN SINK" title="Design system" subtitle="Every token and component on one screen.">
        <div style={{display:"flex",gap:12,marginTop:16}}><Button variant="primary">Primary action</Button><Button variant="secondary">Secondary</Button><Button variant="tertiary">Tertiary →</Button></div>
      </PageHeader>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))",gap:16,marginTop:24}}>
      <Panel><Stat label="Balance" value={12480.5} unit="USDC" delta={2.4}/></Panel>
      <Panel><Stat label="EURC" value={3204.1} unit="EURC" delta={-1.2}/></Panel>
      <Panel featured><Stat label="Agents live" value={3} decimals={0}/><div style={{marginTop:10}}><Badge tone="pos">verified</Badge> <Badge tone="warn">pending</Badge></div></Panel>
    </div>
    <Panel className="au-mono" style={{marginTop:24}}>
      <Table head={<tr><th>Asset</th><th className="num">Amount</th><th className="num">Value</th></tr>}>
        <tr><td>USDC</td><td className="num">12,480.55</td><td className="num">$12,480</td></tr>
        <tr><td>EURC</td><td className="num">3,204.10</td><td className="num">$3,486</td></tr>
      </Table>
    </Panel>
    <div style={{display:"flex",gap:24,marginTop:24,alignItems:"end",flexWrap:"wrap"}}>
      <Tabs items={[{id:"a",label:"Overview"},{id:"b",label:"Activity"}]} value={tab} onChange={setTab}/>
      <div style={{width:280}}><Field label="Amount" value={v} onChange={setV} placeholder="0.00"/></div>
    </div>
  </div></div>;
}

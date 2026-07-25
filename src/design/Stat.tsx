import {formatAmount,deltaTone} from "./format";
export function Stat({label,value,unit,delta,decimals=2}:{label:string;value:number|string;unit?:string;delta?:number;decimals?:number}){
  const val=typeof value==="number"?formatAmount(value,decimals):value;
  return <div className="au-stat">
    <span className="lbl">{label}</span>
    <span className="val">{val}{unit?<span style={{fontSize:".6em",color:"var(--ink-dim)",marginLeft:6}}>{unit}</span>:null}</span>
    {delta!==undefined&&<span className={`delta ${deltaTone(delta)}`}>{delta>0?"▲":delta<0?"▼":"■"} {formatAmount(Math.abs(delta),2)}%</span>}
  </div>;
}

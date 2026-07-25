export function formatAmount(n:number,decimals=2):string{
  return n.toLocaleString("en-US",{minimumFractionDigits:decimals,maximumFractionDigits:decimals});
}
export function deltaTone(n:number):"pos"|"neg"|"flat"{return n>0?"pos":n<0?"neg":"flat";}
export function sparkPath(points:number[],w:number,h:number):string{
  if(points.length===0)return"";
  const max=Math.max(...points),min=Math.min(...points),span=max-min||1;
  const step=points.length>1?w/(points.length-1):0;
  return points.map((p,i)=>`${i===0?"M":"L"}${(i*step).toFixed(1)},${(h-((p-min)/span)*h).toFixed(1)}`).join(" ");
}

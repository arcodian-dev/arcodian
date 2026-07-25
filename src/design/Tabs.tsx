export function Tabs<T extends string>({items,value,onChange}:{items:{id:T;label:string}[];value:T;onChange:(id:T)=>void}){
  return <div className="au-tabs" role="tablist">{items.map(it=><button key={it.id} role="tab" aria-selected={value===it.id} onClick={()=>onChange(it.id)}>{it.label}</button>)}</div>;
}

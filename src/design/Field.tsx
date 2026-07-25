export function Field({label,value,onChange,placeholder,type="text"}:{label:string;value:string;onChange:(v:string)=>void;placeholder?:string;type?:string}){
  return <label className="au-field"><span>{label}</span><input value={value} type={type} placeholder={placeholder} onChange={e=>onChange(e.target.value)}/></label>;
}

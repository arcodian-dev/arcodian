import type {ReactNode} from "react";
type Variant="primary"|"secondary"|"tertiary";
export function Button({children,variant="secondary",as,href,onClick,disabled,type="button"}:{children:ReactNode;variant?:Variant;as?:"a"|"button";href?:string;onClick?:()=>void;disabled?:boolean;type?:"button"|"submit"}){
  const cls=`au-btn au-btn-${variant}`;
  if(as==="a"||href)return <a className={cls} href={href} onClick={onClick}>{children}</a>;
  return <button className={cls} onClick={onClick} disabled={disabled} type={type}>{children}</button>;
}

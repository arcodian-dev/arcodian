import type {ReactNode} from "react";
export function PageHeader({eyebrow,title,subtitle,children}:{eyebrow?:string;title:string;subtitle?:ReactNode;children?:ReactNode}){
  return <header className="au-pagehead">
    {eyebrow&&<span className="au-eyebrow">{eyebrow}</span>}
    <h1 className="au-h1">{title}</h1>
    {subtitle&&<p className="au-sub">{subtitle}</p>}
    {children}
  </header>;
}

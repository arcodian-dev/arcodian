import type {ReactNode} from "react";
export function Table({head,children}:{head:ReactNode;children:ReactNode}){
  return <table className="au-table"><thead>{head}</thead><tbody>{children}</tbody></table>;
}
export function Row({children,onClick}:{children:ReactNode;onClick?:()=>void}){
  return <div className="au-row" onClick={onClick}>{children}</div>;
}

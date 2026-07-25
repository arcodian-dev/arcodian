import type {ReactNode,CSSProperties} from "react";
export function Panel({children,featured,className="",style}:{children:ReactNode;featured?:boolean;className?:string;style?:CSSProperties}){
  return <div className={`au-panel${featured?" featured":""} ${className}`} style={style}>{children}</div>;
}

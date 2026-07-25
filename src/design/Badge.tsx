import type {ReactNode} from "react";
export function Badge({children,tone}:{children:ReactNode;tone?:"pos"|"warn"}){
  return <span className={`au-badge${tone?` ${tone}`:""}`}>{children}</span>;
}

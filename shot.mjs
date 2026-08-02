import {chromium} from "playwright";
const targets=JSON.parse(process.argv[2]);
const b=await chromium.launch();
for(const t of targets){
  const ctx=await b.newContext({viewport:{width:t.w,height:t.h},deviceScaleFactor:1});
  await ctx.addInitScript(()=>{try{localStorage.setItem("arcodian-risk-ack-v1","accepted");}catch(e){}});
  const p=await ctx.newPage();
  try{await p.goto(t.url,{waitUntil:"networkidle",timeout:30000});}catch(e){console.log("nav warn",t.url,String(e).slice(0,80));}
  await p.waitForTimeout(2500);
  await p.screenshot({path:t.out,fullPage:t.full!==false});
  console.log("shot",t.out);
  await ctx.close();
}
await b.close();

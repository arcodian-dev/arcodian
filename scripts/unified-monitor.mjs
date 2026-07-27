#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const DATA = process.env.ARC_DATA_DIR || "/www/wwwroot/arcodian.fun/shared/data";
const OUT = process.env.ARC_MONITOR_OUTPUT || `${DATA}/notifications.json`;
const STATE = process.env.ARC_MONITOR_STATE || `${DATA}/notifications-state.json`;
const now = Math.floor(Date.now() / 1000);
const read = (name, fallback = null) => { try { return JSON.parse(readFileSync(`${DATA}/${name}`, "utf8")); } catch { return fallback; } };
const alerts = [];
const add = (alert) => alerts.push({ createdAt: now * 1000, ...alert });
const age = (iso) => iso ? now - Math.floor(new Date(iso).getTime() / 1000) : Number.POSITIVE_INFINITY;

const analytics = read("analytics.json", {});
const treasury = read("treasury.json", {});
const agentpay = read("agentpay-index.json", {});

if (!analytics?.lend) add({ id:"lend-feed-missing", source:"indexer", severity:"critical", title:"Lend monitoring unavailable", detail:"Analytics feed is missing or invalid.", href:"https://arcodian.fun/analytics" });
else {
  const lend = analytics.lend;
  if (lend.oracleAgeSeconds > 3600) add({ id:"lend-oracle-stale", source:"lend", severity:"critical", title:"ArcLend oracle is stale", detail:`Last accepted price is ${Math.floor(lend.oracleAgeSeconds / 60)} minutes old. Risk-increasing actions fail closed.`, href:"https://lend.arcodian.fun/" });
  else if (lend.oracleAgeSeconds > 1800) add({ id:"lend-oracle-aging", source:"lend", severity:"warning", title:"ArcLend oracle update delayed", detail:`Last accepted price is ${Math.floor(lend.oracleAgeSeconds / 60)} minutes old.`, href:"https://lend.arcodian.fun/" });
  if (lend.pauseFlags > 0) add({ id:`lend-paused-${lend.pauseFlags}`, source:"lend", severity:"warning", title:"ArcLend actions paused", detail:`Active pause flags: ${lend.pauseFlags}.`, href:"https://lend.arcodian.fun/" });
  if (lend.badDebtUsd > 0) add({ id:"lend-bad-debt", source:"lend", severity:"critical", title:"ArcLend bad debt detected", detail:`Recorded bad debt: ${lend.badDebtUsd} USDC.`, href:"https://lend.arcodian.fun/" });
}

try {
  const active = execFileSync("systemctl", ["is-active", "arcodian-lend-pyth-keeper.timer"], { encoding:"utf8" }).trim();
  const result = execFileSync("systemctl", ["show", "arcodian-lend-pyth-keeper.service", "-p", "Result", "--value"], { encoding:"utf8" }).trim();
  if (active !== "active" || result !== "success") add({ id:"lend-keeper-failed", source:"lend", severity:"critical", title:"Pyth keeper needs attention", detail:`Timer ${active}; last run ${result || "unknown"}.`, href:"https://lend.arcodian.fun/" });
} catch { add({ id:"lend-keeper-unreadable", source:"lend", severity:"warning", title:"Pyth keeper status unavailable", detail:"The monitor could not verify the keeper timer.", href:"https://lend.arcodian.fun/" }); }

for (const row of analytics?.bridge?.recent || []) {
  if (row.status === "completed" || row.status === "unverified") continue;
  const seconds = now - Number(row.timestamp || now);
  const accounts = row.account ? [row.account] : [];
  if (seconds >= 3600) add({ id:`bridge-stuck-${row.tx}`, source:"bridge", severity:"critical", title:"Bridge transfer needs attention", detail:`Transfer has not completed after ${Math.floor(seconds / 60)} minutes. Resume with the existing burn hash; do not burn again.`, href:`https://bridge.arcodian.fun/?burn=${row.tx}`, accounts });
  else if (seconds >= 1200) add({ id:`bridge-delayed-${row.tx}`, source:"bridge", severity:"warning", title:"Bridge attestation delayed", detail:`Transfer has been pending for ${Math.floor(seconds / 60)} minutes.`, href:`https://bridge.arcodian.fun/?burn=${row.tx}`, accounts });
}

for (const vault of agentpay?.vaults || []) for (const policy of vault.policies || []) {
  if (!policy.enabled) continue;
  const remaining = Number(policy.validUntil) - now;
  if (remaining <= 0) add({ id:`agentpay-expired-${vault.vault}-${policy.agent}`, source:"agentpay", severity:"warning", title:"Agent Pay policy expired", detail:`Policy for ${policy.agent.slice(0,6)}…${policy.agent.slice(-4)} is no longer active.`, href:`https://arcodian.fun/agentpay?vault=${vault.vault}`, accounts:[vault.owner, policy.agent] });
  else if (remaining <= 86400) add({ id:`agentpay-expiring-${vault.vault}-${policy.agent}`, source:"agentpay", severity:"warning", title:"Agent Pay policy expires soon", detail:`Policy expires in ${Math.max(1, Math.ceil(remaining / 3600))} hours.`, href:`https://arcodian.fun/agentpay?vault=${vault.vault}`, accounts:[vault.owner, policy.agent] });
}

for (const row of treasury?.alerts || []) add({ id:`treasury-${row.type}-${row.tx}`, source:"treasury", severity:row.level === "high" ? "critical" : "notice", title:row.type === "large-outflow" ? "Large treasury outflow" : "New treasury recipient", detail:row.message, href:`https://testnet.arcscan.app/tx/${row.tx}`, accounts:[treasury.treasury] });

for (const [name, timestamp, limit] of [
  ["analytics", analytics?.indexedAt, 30 * 60],
  ["treasury", treasury?.indexedAt, 15 * 60],
  ["Agent Pay", agentpay?.indexedAt, 10 * 60],
]) if (age(timestamp) > limit) add({ id:`indexer-stale-${name.toLowerCase().replaceAll(" ","-")}`, source:"indexer", severity:"warning", title:`${name} indexer is stale`, detail:`Last successful refresh was ${Number.isFinite(age(timestamp)) ? Math.floor(age(timestamp) / 60) + " minutes ago" : "not found"}.`, href:"https://arcodian.fun/analytics" });

alerts.sort((a,b) => ({critical:0,warning:1,notice:2}[a.severity] - ({critical:0,warning:1,notice:2}[b.severity]) || a.id.localeCompare(b.id)));
let prior = { activeIds:[] }; try { prior = JSON.parse(readFileSync(STATE,"utf8")); } catch {}
const activeIds = alerts.map((row)=>row.id); const newIds = activeIds.filter((id)=>!prior.activeIds?.includes(id)); const resolvedIds = (prior.activeIds || []).filter((id)=>!activeIds.includes(id));
const globalAlerts = alerts.filter((row)=>!row.accounts?.length);
const payload = { version:1, generatedAt:new Date().toISOString(), status:globalAlerts.some(x=>x.severity==="critical")?"critical":globalAlerts.some(x=>x.severity==="warning")?"warning":"healthy", counts:{critical:globalAlerts.filter(x=>x.severity==="critical").length,warning:globalAlerts.filter(x=>x.severity==="warning").length,notice:globalAlerts.filter(x=>x.severity==="notice").length,scoped:alerts.length-globalAlerts.length}, newIds, resolvedIds, alerts };
mkdirSync(dirname(OUT),{recursive:true}); writeFileSync(OUT,JSON.stringify(payload,null,2)); writeFileSync(STATE,JSON.stringify({updatedAt:payload.generatedAt,activeIds},null,2));
console.log(JSON.stringify({status:payload.status,...payload.counts,new:newIds.length,resolved:resolvedIds.length}));

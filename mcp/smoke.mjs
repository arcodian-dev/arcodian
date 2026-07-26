// Live smoke test against a running MCP endpoint.
// Usage: node mcp/smoke.mjs [baseUrl]
const base = process.argv[2] || "http://127.0.0.1:8799";

async function call(method, params) {
  const res = await fetch(base.replace(/\/$/, "") + "/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  if (!res.ok) throw new Error(`${method} failed: HTTP ${res.status}`);
  const text = await res.text();
  const line = text.split("\n").find((item) => item.startsWith("data: ")) || text;
  return JSON.parse(line.replace(/^data: /, ""));
}

const list = await call("tools/list", {});
const names = (list.result?.tools || []).map((tool) => tool.name);
if (names.length !== 36) throw new Error(`expected 36 tools, received ${names.length}`);
for (const required of ["inspect_x402_challenge", "quote_nanopayment", "build_nanopayment_authorization", "verify_nanopayment_receipt"]) {
  if (!names.includes(required)) throw new Error(`missing Phase E1 tool ${required}`);
}
for (const required of ["build_send_delegation", "activate_send_delegation", "build_revoke_send_delegation", "revoke_send_delegation", "build_appkit_send", "verify_appkit_send_receipt"]) {
  if (!names.includes(required)) throw new Error(`missing Phase E2 tool ${required}`);
}
if (!names.includes("inspect_unified_balance")) throw new Error("missing Phase E2 Unified Balance tool");
for (const required of ["build_bridge_delegation", "activate_bridge_delegation", "build_revoke_bridge_delegation", "revoke_bridge_delegation", "build_appkit_bridge", "verify_appkit_bridge_receipt"]) {
  if (!names.includes(required)) throw new Error(`missing Phase E2 Bridge tool ${required}`);
}
for (const required of ["build_swap_delegation", "activate_swap_delegation", "build_revoke_swap_delegation", "revoke_swap_delegation", "build_appkit_swap", "verify_appkit_swap_receipt"]) {
  if (!names.includes(required)) throw new Error(`missing Phase E2 Swap tool ${required}`);
}
if (!names.includes("inspect_appkit_delegation")) throw new Error("missing Phase F grant observability tool");
console.log("tools:", names.join(", "));

const agent = await call("tools/call", {
  name: "inspect_agent",
  arguments: { agentId: "851812" },
});
const agentText = agent.result?.content?.[0]?.text || "";
if (!agentText.includes('"score": 40')) throw new Error("agent 851812 score not found");
if (!agentText.includes('"wallet": "0x7D9b5ab14b24Dede3b78b7e1715C1E01032F40C2"')) {
  throw new Error("agent 851812 passport wallet not found");
}
console.log("inspect_agent 851812: score 40, passport wallet verified");

const job = await call("tools/call", {
  name: "inspect_job",
  arguments: { jobId: "2" },
});
const jobText = job.result?.content?.[0]?.text || "";
if (!jobText.includes('"status": "Completed"')) throw new Error("job 2 Completed status not found");
if (!jobText.includes('"providerAgentId": "851812"')) throw new Error("job 2 identity binding not found");
console.log("inspect_job 2: Completed, providerAgentId 851812");

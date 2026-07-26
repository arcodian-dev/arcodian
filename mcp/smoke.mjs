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
if (names.length !== 12) throw new Error(`expected 12 tools, received ${names.length}`);
console.log("tools:", names.join(", "));

const agent = await call("tools/call", {
  name: "inspect_agent",
  arguments: { agentId: "851849" },
});
const agentText = agent.result?.content?.[0]?.text || "";
if (!agentText.includes('"score": 25')) throw new Error("agent 851849 score not found");
console.log("inspect_agent 851849: score 25");

const job = await call("tools/call", {
  name: "inspect_job",
  arguments: { jobId: "4" },
});
const jobText = job.result?.content?.[0]?.text || "";
if (!jobText.includes('"status": "Completed"')) throw new Error("job 4 Completed status not found");
console.log("inspect_job 4: Completed");

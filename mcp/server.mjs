// Arcodian MCP server — Streamable HTTP, stateless. Read + unsigned tx-builders. No keys, no signing.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { makeCtx } from "./sources.ts";
import { TOOLS } from "./tools/registry.ts";
import { AuditLog } from "./audit-log.ts";

const PORT = Number(process.env.MCP_PORT || 8793);
const RATE_RPS = Number(process.env.MCP_RATE_RPS || 4);
const RATE_BURST = Number(process.env.MCP_RATE_BURST || 20);
const MAX_BODY_BYTES = Number(process.env.MCP_MAX_BODY_BYTES || 256 * 1024);
const ctx = makeCtx();
// Durable, hash-chained audit trail. Best-effort: an audit-store failure must
// never drop a tool call, but it is surfaced on stderr for the independent monitor.
let audit = null;
try { audit = new AuditLog(); } catch (e) { process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), auditInit: String(e?.message || e) }) + "\n"); }

// per-IP token bucket
const buckets = new Map();
function allow(ip) {
  const now = Date.now();
  let b = buckets.get(ip) || { tokens: RATE_BURST, t: now };
  b.tokens = Math.min(RATE_BURST, b.tokens + ((now - b.t) / 1000) * RATE_RPS);
  b.t = now;
  if (b.tokens < 1) { buckets.set(ip, b); return false; }
  b.tokens -= 1; buckets.set(ip, b); return true;
}
const argHash = (a) => createHash("sha256").update(JSON.stringify(a || {})).digest("hex").slice(0, 16);

function buildServer(ip) {
  const server = new McpServer(
    { name: "arcodian-mcp", version: "0.1.0" },
    { instructions: "Exposes Arcodian (Arc testnet) identity, jobs, reputation, and payment state. This is NOT the official Arc documentation MCP. Transaction builders return UNSIGNED transactions — the server never holds a key or signs." },
  );
  for (const t of TOOLS) {
    server.registerTool(t.name, { description: t.description, inputSchema: t.schema }, async (args) => {
      const ah = argHash(args);
      process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ip, tool: t.name, argHash: ah }) + "\n");
      try { audit?.append({ tool: t.name, ip, argHash: ah }); }
      catch (e) { process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), auditAppend: String(e?.message || e) }) + "\n"); }
      try {
        const result = await t.handler(args, ctx);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: `error: ${e?.message || e}` }] };
      }
    });
  }
  return server;
}

const httpServer = createServer(async (req, res) => {
  // The service is loopback-only and Apache appends the real client address to
  // X-Forwarded-For. Use the final hop so a client-supplied prefix cannot evade
  // the per-IP rate limiter.
  const forwarded = req.headers["x-forwarded-for"]?.split(",").at(-1);
  const ip = (forwarded || req.socket.remoteAddress || "unknown").trim();
  if (req.method === "GET" && req.url === "/health") { res.writeHead(200).end("ok"); return; }
  if (req.method !== "POST" || req.url !== "/") {
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
    return;
  }
  if (!allow(ip)) { res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ error: "rate limit" })); return; }
  // stateless: fresh transport per request
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = buildServer(ip);
  await server.connect(transport);
  let body = "";
  let bodyBytes = 0;
  let rejected = false;
  req.on("data", (c) => {
    if (rejected) return;
    bodyBytes += c.length;
    if (bodyBytes > MAX_BODY_BYTES) {
      rejected = true;
      res.writeHead(413, { "content-type": "application/json" }).end(JSON.stringify({ error: "request too large" }));
      req.destroy();
      return;
    }
    body += c;
  });
  req.on("end", async () => {
    if (rejected) return;
    let parsed;
    try {
      parsed = body ? JSON.parse(body) : undefined;
    } catch {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid json" }));
      return;
    }
    try {
      await transport.handleRequest(req, res, parsed);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "internal error" }));
      }
      process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), ip, error: String(error?.message || error) }) + "\n");
    }
  });
});
httpServer.listen(PORT, "127.0.0.1", () => console.log(`arcodian-mcp on 127.0.0.1:${PORT}`));

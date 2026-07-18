// Localhost-only EIP-191 (personal_sign) signature verifier.
// PHP endpoints call this over 127.0.0.1 (curl) because aaPanel disables
// proc_open/exec, so PHP cannot spawn node directly. Fail-closed: any bad
// input returns { signer: null }.
import { createServer } from "node:http";
import { verifyMessage } from "ethers";

const PORT = Number(process.env.SIGVERIFY_PORT || 8791);
const HOST = "127.0.0.1";
const MAX_BODY = 16 * 1024;

createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200).end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (req.method !== "POST" || req.url !== "/verify") {
    res.writeHead(404).end(JSON.stringify({ signer: null }));
    return;
  }
  let body = "";
  let aborted = false;
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > MAX_BODY) {
      aborted = true;
      req.destroy();
    }
  });
  req.on("end", () => {
    try {
      if (aborted) throw new Error("body too large");
      const { message, signature } = JSON.parse(body);
      if (typeof message !== "string" || typeof signature !== "string") throw new Error("bad input");
      const signer = verifyMessage(message, signature).toLowerCase();
      res.writeHead(200).end(JSON.stringify({ signer }));
    } catch {
      res.writeHead(200).end(JSON.stringify({ signer: null }));
    }
  });
  req.on("error", () => {
    try { res.writeHead(200).end(JSON.stringify({ signer: null })); } catch { /* ignore */ }
  });
}).listen(PORT, HOST, () => console.log(`arcodian sig-verifier listening on ${HOST}:${PORT}`));

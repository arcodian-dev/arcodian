import express from "express";
import { Contract, JsonRpcProvider, verifyTypedData } from "ethers";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const ZERO = "0x0000000000000000000000000000000000000000";

// Voucher store: payer(lower) => { provider, cumulative, signature, updatedAt }. Persisting the
// signed voucher is what lets a separate redeemer settle on-chain (serve never holds a key) and,
// critically, redeem before a payer's deallocation challenge window closes. Loading it on boot
// also seeds lastSeen so a restart stays consistent with vouchers already served but not settled.
function loadStore(path) { if (!path) return {}; try { return JSON.parse(readFileSync(path, "utf8")) || {}; } catch { return {}; } }
function saveStore(path, obj) {
  if (!path) return;
  try { mkdirSync(dirname(path), { recursive: true }); const tmp = `${path}.tmp`; writeFileSync(tmp, JSON.stringify(obj)); renameSync(tmp, path); }
  catch (e) { console.error("voucher store write failed:", e?.message || e); }
}
const VAULT_ABI = ["function subs(address,address) view returns(uint256 allocated,uint256 redeemed,uint64 deallocateAt)"];
const TYPES = { Voucher: [{ name: "payer", type: "address" }, { name: "provider", type: "address" }, { name: "cumulative", type: "uint256" }] };

export function verifyVoucherCall({ payer, provider, recoveredSigner, myProvider, cumulative, allocated, lastSeen, price }) {
  if (!payer || payer === ZERO) return { ok: false, reason: "no payer" };
  if (String(provider).toLowerCase() !== String(myProvider).toLowerCase()) return { ok: false, reason: "wrong provider" };
  if (String(recoveredSigner).toLowerCase() !== String(payer).toLowerCase()) return { ok: false, reason: "signer != payer" };
  if (BigInt(cumulative) > BigInt(allocated)) return { ok: false, reason: "exceeds allocated" };
  if (BigInt(cumulative) - BigInt(lastSeen) !== BigInt(price)) return { ok: false, reason: "bad delta" };
  return { ok: true };
}

export function createServer({ rpc, vault, provider, chainId, priceWei, handler, store }) {
  const rpcProvider = new JsonRpcProvider(rpc, undefined, { batchMaxCount: 1 });
  const vaultC = new Contract(vault, VAULT_ABI, rpcProvider);
  const domain = { name: "AgentRail", version: "1", chainId, verifyingContract: vault };
  const lastSeen = new Map(); // payer(lower) => bigint cumulative
  const persisted = store ? loadStore(store) : {}; // seed from disk so a restart resumes cleanly
  const me = String(provider).toLowerCase();
  for (const [k, v] of Object.entries(persisted)) {
    if (v?.cumulative && String(v.provider ?? provider).toLowerCase() === me) lastSeen.set(k, BigInt(v.cumulative));
  }
  const app = express();
  app.use(express.json());
  app.post("/serve", async (req, res) => {
    try {
      const { payer, provider: vProvider, cumulative, signature, prompt } = req.body;
      const value = { payer, provider: vProvider, cumulative: BigInt(cumulative) };
      const recovered = verifyTypedData(domain, TYPES, value, signature);
      const sub = await vaultC.subs(payer, provider);
      const key = String(payer).toLowerCase();
      // Floor the seen-cumulative at the on-chain redeemed amount so a fresh provider
      // process (in-memory map empty) stays consistent with what's already been settled.
      const seen = lastSeen.get(key) ?? sub.redeemed;
      const check = verifyVoucherCall({ payer, provider: vProvider, recoveredSigner: recovered, myProvider: provider, cumulative: BigInt(cumulative), allocated: sub.allocated, lastSeen: seen, price: priceWei });
      if (!check.ok) return res.status(402).json({ error: check.reason });
      lastSeen.set(key, BigInt(cumulative));
      if (store) { persisted[key] = { provider, cumulative: String(cumulative), signature, updatedAt: new Date().toISOString() }; saveStore(store, persisted); }
      const completion = await handler(prompt);
      res.json({ cumulative: String(cumulative), completion });
    } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });
  return app;
}

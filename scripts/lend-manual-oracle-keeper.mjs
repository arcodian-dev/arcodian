import { Contract, Wallet } from "ethers";
import { healthyProvider } from "./rpc-failover.mjs";

// Interim EUR/USD source while Pyth's feed on Arc Testnet stays stale
// upstream (Hermes itself serves the same frozen publish_time, so no amount
// of on-chain retrying fixes it). Frankfurter is ECB-sourced, free, no key.
// Daily-resolution FX is adequate for a testnet lending market; this keeper
// and ArcManualOracle are meant to be swapped back to ArcPythOracle once
// Pyth resumes publishing, not to be the permanent price source.
const FX_URL = process.env.FX_URL || "https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD";
const ORACLE = process.env.LEND_MANUAL_ORACLE_ADDRESS;
if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY is required");
if (!ORACLE) throw new Error("LEND_MANUAL_ORACLE_ADDRESS is required");

const response = await fetch(FX_URL);
if (!response.ok) throw new Error(`FX source HTTP ${response.status}`);
const payload = await response.json();
const rate = payload?.rates?.USD;
if (!rate || !(rate > 0)) throw new Error("FX source returned no usable EUR/USD rate");

const priceWad = BigInt(Math.round(rate * 1e18));

const { provider, url: rpc, candidates } = await healthyProvider();
const signer = new Wallet(process.env.PRIVATE_KEY, provider);
const oracle = new Contract(ORACLE, [
  "function setPrice(uint256 next)",
  "function value() view returns(uint256)",
  "function updatedAt() view returns(uint64)",
], signer);

const tx = await oracle.setPrice(priceWad);
await tx.wait();
console.log(JSON.stringify({
  oracle: ORACLE,
  rpc: new URL(rpc).hostname,
  rpcCandidates: candidates,
  tx: tx.hash,
  eurUsd: rate,
  priceWad: priceWad.toString(),
  updatedAt: Number(await oracle.updatedAt()),
}));

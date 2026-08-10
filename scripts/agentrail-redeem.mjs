// AgentRail provider redeemer — settles signed vouchers on-chain for the provider wallet.
//
// serve.mjs verifies vouchers off-chain (zero gas per call) and persists the latest signed
// voucher per payer to VOUCHER_STORE. It never holds a key. This job reads that store and calls
// ArcPayVault.redeem(payer, cumulative, signature) so the provider actually gets paid, and —
// critically — force-settles a payer's outstanding voucher before that payer's deallocation
// challenge window closes. Without this, a payer can requestDeallocate + wait 1 day +
// finalizeDeallocate to drop `allocated` to `redeemed`, making any un-redeemed voucher revert
// (ExceedsAllocated) — the provider would lose payment for calls it already served.
//
// Idempotent: a voucher whose cumulative <= on-chain redeemed is skipped, so re-runs are safe.
// Env: ARC_RPC_URL, PAY_VAULT_ADDRESS, PROVIDER_PK (via EnvironmentFile), VOUCHER_STORE,
//      MIN_REDEEM_USDC (batch dust below this unless a dealloc window is closing),
//      DEALLOC_SAFETY_SEC (force-redeem when the window closes within this many seconds).
import { Wallet, JsonRpcProvider, Contract, formatEther, parseEther } from "ethers";
import { readFileSync } from "node:fs";

const rpc = process.env.ARC_RPC_URL || "https://rpc.drpc.testnet.arc.io";
const storePath = process.env.VOUCHER_STORE || "/var/lib/arcodian/agentrail-vouchers.json";
const vaultAddr = process.env.PAY_VAULT_ADDRESS;
const pk = process.env.PROVIDER_PK;
const minRedeem = parseEther(process.env.MIN_REDEEM_USDC || "0.05");
const safety = BigInt(process.env.DEALLOC_SAFETY_SEC || "21600"); // 6h before the window closes

if (!vaultAddr || !pk) { console.error("PAY_VAULT_ADDRESS and PROVIDER_PK are required"); process.exit(1); }

let store;
try { store = JSON.parse(readFileSync(storePath, "utf8")) || {}; }
catch { console.log(`no voucher store at ${storePath} — nothing to redeem`); process.exit(0); }

const provider = new JsonRpcProvider(rpc, undefined, { batchMaxCount: 1 });
const wallet = new Wallet(pk, provider);
const me = wallet.address.toLowerCase();
const VAULT_ABI = [
  "function redeem(address,uint256,bytes)",
  "function subs(address,address) view returns(uint256 allocated,uint256 redeemed,uint64 deallocateAt)",
];
const vault = new Contract(vaultAddr, VAULT_ABI, wallet);
const now = BigInt(Math.floor(Date.now() / 1000));

let redeemed = 0, skipped = 0, failed = 0;
for (const [payer, v] of Object.entries(store)) {
  try {
    if (!v?.cumulative || !v?.signature) { skipped++; continue; }
    if (v.provider && v.provider.toLowerCase() !== me) { skipped++; continue; } // not this provider's voucher
    const cumulative = BigInt(v.cumulative);
    const sub = await vault.subs(payer, wallet.address);
    if (cumulative <= sub.redeemed) { skipped++; continue; }                     // already settled
    if (cumulative > sub.allocated) {                                            // allocation shrank (finalized dealloc)
      console.warn(`voucher for ${payer} exceeds allocation (${formatEther(cumulative)} > ${formatEther(sub.allocated)}) — cannot redeem`);
      skipped++; continue;
    }
    const headroom = cumulative - sub.redeemed;
    const windowClosing = sub.deallocateAt !== 0n && now + safety >= sub.deallocateAt;
    if (headroom < minRedeem && !windowClosing) { skipped++; continue; }         // let it accrue; no rush
    const reason = windowClosing ? "dealloc-window-closing" : "threshold";
    const tx = await vault.redeem(payer, cumulative, v.signature);
    console.log(`redeem payer=${payer} cumulative=${formatEther(cumulative)} (+${formatEther(headroom)}) [${reason}] tx=${tx.hash}`);
    await tx.wait();
    redeemed++;
  } catch (e) { console.error(`redeem failed for ${payer}:`, e?.shortMessage || e?.message || e); failed++; }
}
console.log(`redeemer done: redeemed=${redeemed} skipped=${skipped} failed=${failed}`);

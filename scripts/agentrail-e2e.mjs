// AgentRail live E2E on Arc testnet: deposit -> allocate -> 2 off-chain vouchers served ->
// provider redeems the latest voucher on-chain (0.5% fee) -> consumer files on-chain reputation.
// Requires a running demo provider (scripts/demo/agentrail-provider.mjs). Voucher helpers inlined.
import { Wallet, JsonRpcProvider, Contract, parseEther, formatEther } from "ethers";
import assert from "node:assert";

const rpc = process.env.ARC_RPC_URL || "https://rpc.drpc.testnet.arc.io";
const provider = new JsonRpcProvider(rpc, undefined, { batchMaxCount: 1 });
const consumer = new Wallet(process.env.CONSUMER_PK, provider);
const providerWallet = new Wallet(process.env.PROVIDER_PK, provider);
const chainId = Number((await provider.getNetwork()).chainId);
const vault = process.env.PAY_VAULT_ADDRESS;
const prov = providerWallet.address;
const endpointURI = process.env.PROVIDER_URL || "http://localhost:8795";
const price = parseEther("0.01");

const domain = { name: "AgentRail", version: "1", chainId, verifyingContract: vault };
const types = { Voucher: [{ name: "payer", type: "address" }, { name: "provider", type: "address" }, { name: "cumulative", type: "uint256" }] };

const VAULT_ABI = ["function deposit() payable", "function allocate(address,uint256)", "function redeem(address,uint256,bytes)", "function subs(address,address) view returns(uint256 allocated,uint256 redeemed,uint64)"];
const REP_ABI = ["function giveFeedback(uint256 agentId,int128 score,uint8 decimals,string tag1,string tag2,string endpoint,string fileuri,bytes32 filehash)"];
const vC = new Contract(vault, VAULT_ABI, consumer);
const vP = new Contract(vault, VAULT_ABI, providerWallet);

await (await vC.deposit({ value: parseEther("0.1") })).wait();
await (await vC.allocate(prov, parseEther("0.05"))).wait();

let cumulative = 0n; let lastSig;
for (const prompt of ["ping", "pong"]) {
  cumulative += price;
  lastSig = await consumer.signTypedData(domain, types, { payer: consumer.address, provider: prov, cumulative });
  const resp = await fetch(new URL("/serve", endpointURI).toString(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payer: consumer.address, provider: prov, cumulative: cumulative.toString(), signature: lastSig, prompt }) });
  const raw = await resp.text();
  assert.ok(resp.ok, `serve failed ${resp.status}: ${raw}`);
  assert.ok(JSON.parse(raw).completion?.length > 0, "empty completion");
}

const provBefore = await provider.getBalance(prov);
await (await vP.redeem(consumer.address, cumulative, lastSig)).wait(); // redeems both calls (0.02) in one tx
const provAfter = await provider.getBalance(prov);
const sub = await vC.subs(consumer.address, prov);
assert.equal(sub.redeemed.toString(), cumulative.toString(), "redeemed != cumulative");
assert.ok(provAfter > provBefore, "provider not paid");

const rep = new Contract(process.env.REPUTATION_REGISTRY_ADDRESS, REP_ABI, consumer);
const fb = await (await rep.giveFeedback(process.env.PROVIDER_AGENT_ID, 90, 0, "agentrail", "call", endpointURI, "", "0x" + "00".repeat(32))).wait();
assert.equal(fb.status, 1, "giveFeedback failed");

console.log("E2E PASS", { redeemed: formatEther(cumulative) + " USDC", providerGainAfterFee: formatEther(provAfter - provBefore), feedbackTx: fb.hash });

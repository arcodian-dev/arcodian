// AgentRail demo consumer: deposit credits once, allocate to a provider, then pay per call with
// off-chain EIP-712 vouchers (zero gas per call). Voucher helpers inlined (pure ethers).
import { Wallet, JsonRpcProvider, Contract, parseEther, formatEther } from "ethers";

const rpc = process.env.ARC_RPC_URL || "https://rpc.drpc.testnet.arc.io";
const provider = new JsonRpcProvider(rpc, undefined, { batchMaxCount: 1 });
const wallet = new Wallet(process.env.CONSUMER_PK, provider);
const chainId = Number((await provider.getNetwork()).chainId);
const vault = process.env.PAY_VAULT_ADDRESS;
const prov = process.env.PROVIDER_ADDR;
const endpointURI = process.env.PROVIDER_URL || "http://localhost:8795";
const price = parseEther("0.01");

const domain = { name: "AgentRail", version: "1", chainId, verifyingContract: vault };
const types = { Voucher: [{ name: "payer", type: "address" }, { name: "provider", type: "address" }, { name: "cumulative", type: "uint256" }] };

const VAULT_ABI = ["function deposit() payable", "function allocate(address,uint256)", "function subs(address,address) view returns(uint256 allocated,uint256 redeemed,uint64)"];
const v = new Contract(vault, VAULT_ABI, wallet);

console.log("depositing 0.1 USDC + allocating 0.05 to provider (on-chain, once)...");
await (await v.deposit({ value: parseEther("0.1") })).wait();
await (await v.allocate(prov, parseEther("0.05"))).wait();

let cumulative = 0n;
for (const prompt of ["What is an autonomous AI agent, in one sentence?", "Name one benefit of on-chain agent-to-agent payments."]) {
  cumulative += price;
  const signature = await wallet.signTypedData(domain, types, { payer: wallet.address, provider: prov, cumulative });
  const resp = await fetch(new URL("/serve", endpointURI).toString(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payer: wallet.address, provider: prov, cumulative: cumulative.toString(), signature, prompt }) });
  const body = await resp.json();
  console.log(`\n[voucher cumulative ${formatEther(cumulative)} USDC | off-chain] ${prompt}\n-> ${body.completion || JSON.stringify(body)}`);
}
console.log("\n2 calls served against off-chain vouchers; only deposit+allocate touched the chain.");

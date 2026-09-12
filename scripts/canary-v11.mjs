#!/usr/bin/env node
// Live mainnet canary for ArcPumpV11 — create a real (tiny) launch, buy,
// then sell, verifying the creator-fee split actually accrues on-chain.
// Same spirit as every prior engine's canary (V6/V7/V9/V10), scoped down
// since V11 has no "suite" contract to probe, just the factory directly.
import { Contract, JsonRpcProvider, Wallet, formatEther, parseEther } from "ethers";
import { readFileSync } from "node:fs";

const RPC = process.env.CANARY_RPC_URL || "https://rpc.arc-scan.org/";
const FACTORY = process.env.CANARY_FACTORY || "0x12ae88784D1CB2A23408BBA483B4bBBc88226FF9";
const PK = process.env.PRIVATE_KEY;
if (!PK) { console.error("Set PRIVATE_KEY env (decrypt the keystore first)."); process.exit(1); }

const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true, batchMaxCount: 1 });
const wallet = new Wallet(PK, provider);

const FACTORY_ABI = ["function createLaunch(string,string,string) external returns(address,address)", "event LaunchCreated(uint256 indexed id, address indexed creator, address token, address curve)"];
const CURVE_ABI = [
  "function buy(uint256,uint64) external payable returns(uint256)",
  "function sell(uint256,uint256,uint64) external returns(uint256)",
  "function creatorFeesAccrued() view returns(uint256)",
  "function accruedProtocolFees() view returns(uint256)",
  "function creator() view returns(address)",
  "function graduationFeeTaken() view returns(uint256)",
];
const TOKEN_ABI = ["function approve(address,uint256) external returns(bool)", "function balanceOf(address) view returns(uint256)"];

async function main() {
  console.log("Wallet:", wallet.address);
  console.log("Balance:", formatEther(await provider.getBalance(wallet.address)), "USDC (native)");

  const factory = new Contract(FACTORY, FACTORY_ABI, wallet);
  console.log("\n1) createLaunch...");
  const createTx = await factory.createLaunch("Canary V11", "CANV11", "ipfs://canary-v11-test");
  const createReceipt = await createTx.wait();
  const launchEvent = createReceipt.logs.map((log) => { try { return factory.interface.parseLog(log); } catch { return null; } }).find((parsed) => parsed?.name === "LaunchCreated");
  if (!launchEvent) throw new Error("LaunchCreated event not found");
  const tokenAddr = launchEvent.args.token;
  const curveAddr = launchEvent.args.curve;
  console.log("   token:", tokenAddr);
  console.log("   curve:", curveAddr);
  console.log("   tx:", createTx.hash);

  const curve = new Contract(curveAddr, CURVE_ABI, wallet);
  const token = new Contract(tokenAddr, TOKEN_ABI, wallet);

  console.log("\n2) buy 0.05 USDC (native)...");
  const buyTx = await curve.buy(1n, Math.floor(Date.now() / 1000) + 3600, { value: parseEther("0.05") });
  await buyTx.wait();
  console.log("   tx:", buyTx.hash);

  const creatorFeesAfterBuy = await curve.creatorFeesAccrued();
  const protocolFeesAfterBuy = await curve.accruedProtocolFees();
  console.log("   creatorFeesAccrued:", formatEther(creatorFeesAfterBuy), "USDC");
  console.log("   accruedProtocolFees:", formatEther(protocolFeesAfterBuy), "USDC");

  const tokenBalance = await token.balanceOf(wallet.address);
  console.log("\n3) sell half back...");
  const sellAmount = tokenBalance / 2n;
  const approveTx = await token.approve(curveAddr, sellAmount);
  await approveTx.wait();
  const sellTx = await curve.sell(sellAmount, 1n, Math.floor(Date.now() / 1000) + 3600);
  await sellTx.wait();
  console.log("   tx:", sellTx.hash);

  const creatorFeesFinal = await curve.creatorFeesAccrued();
  const protocolFeesFinal = await curve.accruedProtocolFees();
  const creatorOnChain = await curve.creator();
  console.log("\n=== RESULT ===");
  console.log("creator():", creatorOnChain, creatorOnChain.toLowerCase() === wallet.address.toLowerCase() ? "(matches wallet, correct)" : "(MISMATCH)");
  console.log("creatorFeesAccrued after buy+sell:", formatEther(creatorFeesFinal), "USDC");
  console.log("accruedProtocolFees after buy+sell:", formatEther(protocolFeesFinal), "USDC");
  console.log("Split check (should be equal, 50/50):", creatorFeesFinal === protocolFeesFinal ? "PASS — exact 50/50" : `MISMATCH (creator=${creatorFeesFinal} protocol=${protocolFeesFinal})`);
  console.log("\nRemaining balance:", formatEther(await provider.getBalance(wallet.address)), "USDC");
  console.log("\nCanary token (for reference, will show as a real tiny launch on /market):", tokenAddr);
}

main().catch((error) => { console.error("CANARY FAILED:", error); process.exit(1); });

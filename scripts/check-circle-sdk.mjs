import { AppKit } from "@circle-fin/app-kit";
import { createViemAdapterFromProvider } from "@circle-fin/adapter-viem-v2";
import appKitPackage from "@circle-fin/app-kit/package.json" with { type: "json" };
import adapterPackage from "@circle-fin/adapter-viem-v2/package.json" with { type: "json" };

const kit = new AppKit();
const capabilities = {
  bridge: typeof kit.bridge === "function",
  estimateBridge: typeof kit.estimateBridge === "function",
  retryBridge: typeof kit.retryBridge === "function",
  swap: typeof kit.swap === "function",
  estimateSwap: typeof kit.estimateSwap === "function",
  send: typeof kit.send === "function",
  unifiedBalance: Boolean(kit.unifiedBalance),
  viemAdapter: typeof createViemAdapterFromProvider === "function",
};
const result = {
  ok: Object.values(capabilities).every(Boolean),
  appKit: appKitPackage.version,
  adapter: adapterPackage.version,
  capabilities,
};
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;

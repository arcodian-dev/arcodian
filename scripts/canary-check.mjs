import { Contract, JsonRpcProvider, isAddress } from "ethers";

const required = ["CANARY_RPC_URL", "CANARY_SUITE", "CANARY_TREASURY"];
for (const key of required) if (!process.env[key]) throw new Error(`Missing ${key}`);
if (!isAddress(process.env.CANARY_SUITE) || !isAddress(process.env.CANARY_TREASURY)) {
  throw new Error("Invalid canary address");
}

const provider = new JsonRpcProvider(process.env.CANARY_RPC_URL);
const suite = new Contract(
  process.env.CANARY_SUITE,
  [
    "function pumpFactory() view returns(address)",
    "function dexFactory() view returns(address)",
    "function treasury() view returns(address)",
    "function graduationThreshold() view returns(uint256)",
    "function ENGINE_VERSION() view returns(uint8)",
  ],
  provider,
);
const [network, suiteCode, pumpAddress, dexAddress, treasury, threshold] = await Promise.all([
  provider.getNetwork(),
  provider.getCode(process.env.CANARY_SUITE),
  suite.pumpFactory(),
  suite.dexFactory(),
  suite.treasury(),
  suite.graduationThreshold(),
]);
const pump = new Contract(
  pumpAddress,
  [
    "function dexFactory() view returns(address)",
    "function treasury() view returns(address)",
    "function launchCount() view returns(uint256)",
  ],
  provider,
);
const dex = new Contract(
  dexAddress,
  [
    "function owner() view returns(address)",
    "function pumpFactory() view returns(address)",
    "function treasury() view returns(address)",
  ],
  provider,
);
const [pumpCode, dexCode, pumpTreasury, dexTreasury, pumpDex, dexPump, dexOwner, launchCount] =
  await Promise.all([
    provider.getCode(pumpAddress),
    provider.getCode(dexAddress),
    pump.treasury(),
    dex.treasury(),
    pump.dexFactory(),
    dex.pumpFactory(),
    dex.owner(),
    pump.launchCount(),
  ]);

let engineVersion = null;
if (process.env.CANARY_ENGINE_VERSION) {
  try {
    engineVersion = Number(await suite.ENGINE_VERSION());
  } catch {
    engineVersion = 0;
  }
}

const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const checks = {
  bytecode: suiteCode !== "0x" && pumpCode !== "0x" && dexCode !== "0x",
  treasury:
    same(treasury, process.env.CANARY_TREASURY) &&
    same(pumpTreasury, treasury) &&
    same(dexTreasury, treasury),
  wiring: same(pumpDex, dexAddress) && same(dexPump, pumpAddress),
  ownerLockedToSuite: same(dexOwner, process.env.CANARY_SUITE),
};
if (process.env.CANARY_CHAIN_ID) {
  checks.chainId = network.chainId === BigInt(process.env.CANARY_CHAIN_ID);
}
if (process.env.CANARY_THRESHOLD_WEI) {
  checks.threshold = threshold === BigInt(process.env.CANARY_THRESHOLD_WEI);
}
if (process.env.CANARY_ENGINE_VERSION) {
  checks.engineVersion = engineVersion === Number(process.env.CANARY_ENGINE_VERSION);
}

const report = {
  chainId: Number(network.chainId),
  engineVersion,
  suite: process.env.CANARY_SUITE,
  pump: pumpAddress,
  dex: dexAddress,
  treasury,
  threshold: threshold.toString(),
  launchCount: Number(launchCount),
  checks,
};
report.ok = Object.values(checks).every(Boolean);
console.log(JSON.stringify(report, null, 2));
await provider.destroy();
if (!report.ok) process.exit(1);

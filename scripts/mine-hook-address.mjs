#!/usr/bin/env node
// Finds a CREATE2 salt that puts ArcodianLaunchHook at an address whose low
// bits carry its permissions.
//
// Uniswap V4 encodes a hook's permissions in its own address: the
// PoolManager reads the low 14 bits and calls only the entry points those
// bits enable. A hook deployed at an ordinary address is simply never
// called, and initialize() rejects a pool whose hook address does not match
// the permissions the hook claims. So the address is not chosen — it is
// searched for, by brute-forcing CREATE2 salts until one lands.
//
// ArcodianLaunchHook needs beforeSwap (1 << 7) and beforeSwapReturnDelta
// (1 << 3): address & 0x3FFF == 0x0088.
import { readFileSync } from "node:fs";
import { keccak256, getCreate2Address, AbiCoder, concat } from "ethers";

const BEFORE_SWAP_FLAG = 1n << 7n;
const BEFORE_SWAP_RETURNS_DELTA_FLAG = 1n << 3n;
// HOOK=V14 mines ArcodianLaunchHookV14: beforeInitialize (1 << 13),
// beforeSwap, afterSwap (1 << 6), and both return-delta flags (1 << 3,
// 1 << 2) -> 0x20CC. Its constructor also takes the quote currency.
const V14 = process.env.HOOK === "V14" || process.env.HOOK === "V15";
const TARGET = V14 ? 0x20ccn : BEFORE_SWAP_FLAG | BEFORE_SWAP_RETURNS_DELTA_FLAG;
const MASK = (1n << 14n) - 1n;

// Foundry's deterministic CREATE2 deployer, present on every EVM chain that
// has the standard predeploy — confirmed live on Arc Mainnet before use.
const CREATE2_DEPLOYER = process.env.CREATE2_DEPLOYER || "0x4e59b44847b379578588920cA78FbF26c0B4956C";

const [poolManager, factory, treasury] = process.argv.slice(2);
if (!poolManager || !treasury) {
  console.error("usage: mine-hook-address.mjs <poolManager> <factory|0x0> <treasury>");
  process.exit(1);
}

// V15's hook has the same permissions and constructor as V14's.
const artifactPath = V14
  ? `contracts/out-v4/ArcodianLaunchHook${process.env.HOOK}.sol/ArcodianLaunchHook${process.env.HOOK}.json`
  : "contracts/out-v4/ArcodianLaunchHook.sol/ArcodianLaunchHook.json";
const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
const creation = artifact.bytecode.object;
// The second argument is the hook's admin (older name: factory).
const args = V14
  ? AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address", "address"],
    [poolManager, factory, treasury, process.env.QUOTE || "0x3600000000000000000000000000000000000000"],
  )
  : AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address"],
    [poolManager, factory || "0x0000000000000000000000000000000000000000", treasury],
  );
const initCodeHash = keccak256(concat([creation, args]));

// SALT_START skips salts already spent: CREATE2 with the same salt and init
// code lands on the same address, and a second deploy there simply fails.
// The V12 hook took salt 0x1c with these exact constructor arguments.
let salt = BigInt(process.env.SALT_START || "0");
const started = Date.now();
for (;;) {
  const saltHex = `0x${salt.toString(16).padStart(64, "0")}`;
  const address = getCreate2Address(CREATE2_DEPLOYER, saltHex, initCodeHash);
  if ((BigInt(address) & MASK) === TARGET) {
    console.log(JSON.stringify({
      salt: saltHex,
      address,
      initCodeHash,
      flags: `0x${(BigInt(address) & MASK).toString(16).padStart(4, "0")}`,
      tried: Number(salt),
      seconds: ((Date.now() - started) / 1000).toFixed(1),
    }, null, 2));
    break;
  }
  salt += 1n;
  if (salt % 500_000n === 0n) process.stderr.write(`  tried ${salt}…\n`);
}

#!/usr/bin/env node
// Publishes source for Arcodian's Arc Mainnet contracts on arcexplorer.org.
//
// Why this exists: verification does not propagate by bytecode. Two launches
// from the same factory produce byte-identical PumpToken runtime code, and
// verifying one leaves the other unverified — checked directly, FIC verified
// while two ARDN tokens sharing a bytecode hash stayed unverified. So every
// launched coin needs its own call, which is not something to do by hand as
// the catalog grows. A verified coin is also what lets an external buyer bot
// read the ABI and trade it straight from a pasted address.
//
// Arc has no Sourcify support (chain 5042 is not listed, so forge verify and
// every other Sourcify client cannot verify anything here at all).
// arcexplorer.org runs its own compiler and matcher, which is what makes this
// possible.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const API = process.env.ARCEXPLORER_API || "https://www.arcexplorer.org/api/v1";
// The curve engines build with 0.8.24 and no IR; the V4 engine needs 0.8.26
// and viaIR. That difference reaches the coins themselves: a factory embeds
// its child's creation bytecode, so a PumpToken minted by the V12 factory is
// not byte-identical to one minted by V11 even though the source file is the
// same. Verifying a V12 coin against the 0.8.24 build simply does not match.
const COMPILER_BY_PROFILE = {
  default: process.env.SOLC_VERSION || "0.8.24+commit.e11b9ed9",
  v4: process.env.SOLC_VERSION_V4 || "0.8.26+commit.8a97fa7a",
};
const CONTRACTS = "/root/.openclaw/workspace/arc/contracts";
const INDEX = process.env.MAINNET_INDEX_PATH || "/www/wwwroot/arcodian.fun/shared/data/mainnet-market-index.json";
const STATE = process.env.VERIFY_STATE || "/www/wwwroot/arcodian.fun/shared/data/verified-mainnet.json";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * forge's own standard-json input. Hand-building the source list works for a
 * leaf contract but not for one that deploys another: the child's creation
 * bytecode, metadata hash included, is embedded in the parent's runtime code,
 * so any drift in settings or source paths changes the parent too. Both pump
 * factories failed a hand-built request and matched immediately on this.
 */
function standardJson(path, name, profile = "default") {
  const out = execFileSync(
    "forge",
    ["verify-contract", "0x0000000000000000000000000000000000000000", `${path}:${name}`, "--show-standard-json-input"],
    { cwd: CONTRACTS, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, FOUNDRY_PROFILE: profile } },
  ).toString();
  return JSON.parse(out);
}

async function status(address) {
  try {
    const res = await fetch(`${API}/contracts/${address}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function verify(address, path, name, input, profile = "default") {
  const body = { address, compilerVersion: COMPILER_BY_PROFILE[profile], contractPath: path, contractName: name, sources: input.sources, settings: input.settings };
  // The endpoint rate-limits and 502s on larger sources; a refusal to serve
  // is not a verification failure and must not be recorded as one.
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${API}/contracts/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await res.text();
    if (res.status === 429 || res.status === 502 || res.status === 504) { await sleep(12_000 * (attempt + 1)); continue; }
    if (res.status === 201) return { ok: true, ...JSON.parse(text) };
    if (res.status === 409) return { ok: true, already: true };
    return { ok: false, error: text.slice(0, 200) };
  }
  return { ok: false, error: "rate limited" };
}

const done = (() => { try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return { contracts: {} }; } })();
done.contracts ||= {};

// Every launched coin is a PumpToken, but which build of it depends on the
// factory that minted it — see COMPILER_BY_PROFILE.
const tokenInputs = {
  default: standardJson("src/ArcPump.sol", "PumpToken", "default"),
  v4: standardJson("src/ArcPump.sol", "PumpToken", "v4"),
};
const profileFor = (engineVersion) => (Number(engineVersion) >= 12 ? "v4" : "default");

// Each launch also deploys its own bonding curve, and that is the contract a
// trader actually calls before graduation — it deserves published source as
// much as the token does. Which curve depends on the factory that made it, so
// the engine version is read off the launch itself and the inputs are built
// once per engine rather than once per launch.
const CURVES = {
  8: ["src/ArcPumpV8.sol", "ArcPumpCurveV8"],
  9: ["src/ArcPumpV9.sol", "ArcPumpCurveV9"],
  10: ["src/ArcPumpV10.sol", "ArcPumpCurveV10"],
  11: ["src/ArcPumpV11.sol", "ArcPumpCurveV11"],
};
const curveInputs = new Map();
const curveInputFor = (engine) => {
  const spec = CURVES[engine];
  if (!spec) return null;
  if (!curveInputs.has(engine)) curveInputs.set(engine, { spec, input: standardJson(spec[0], spec[1]) });
  return curveInputs.get(engine);
};

const launches = (() => {
  try {
    const data = JSON.parse(readFileSync(INDEX, "utf8"));
    // Arcodian launches only: an externally discovered pool's token is
    // somebody else's contract and not ours to publish source for.
    //
    // Keyed off the factory rather than the presence of a curve — a V12
    // launch has no curve at all, and testing for one silently skipped every
    // coin from the current engine.
    return (data.launches || []).filter((row) => !row.globalPool && row.address && (row.curve || Number(row.engineVersion) === 12));
  } catch { return []; }
})();

let verified = 0, skipped = 0, failed = 0;
for (const launch of launches) {
  const address = launch.address.toLowerCase();
  let tokenDone = Boolean(done.contracts[address]?.verified);
  if (!tokenDone) {
    const current = await status(address);
    if (current?.verified) {
      done.contracts[address] = { verified: true, name: current.contractName, at: new Date().toISOString() };
      tokenDone = true;
    }
  }
  const profile = profileFor(launch.engineVersion);
  const result = tokenDone ? { ok: true, already: true } : await verify(launch.address, "src/ArcPump.sol", "PumpToken", tokenInputs[profile], profile);
  if (tokenDone) {
    skipped += 1;
  } else if (result.ok) {
    done.contracts[address] = { verified: true, name: "PumpToken", symbol: launch.symbol, engineVersion: Number(launch.engineVersion) || 0, matchType: result.matchType || "already", at: new Date().toISOString() };
    verified += 1;
    console.log(`verified ${launch.symbol} ${launch.address} (${result.matchType || "already"})`);
  } else {
    failed += 1;
    console.error(`failed ${launch.symbol} ${launch.address}: ${result.error}`);
  }
  await sleep(9_000);

  // The launch's curve, using whichever engine produced it.
  const engine = Number(launch.engineVersion || 0);
  // A V12 launch has no curve — it trades in a V4 pool, which is not a
  // contract at all.
  if (engine >= 12) continue;
  const curveAddress = String(launch.curve || "").toLowerCase();
  const curveSpec = curveInputFor(engine);
  if (!curveSpec || !curveAddress || done.contracts[curveAddress]?.verified) continue;
  const curveStatus = await status(curveAddress);
  if (curveStatus?.verified) {
    done.contracts[curveAddress] = { verified: true, name: curveStatus.contractName, at: new Date().toISOString() };
    continue;
  }
  const curveResult = await verify(launch.curve, curveSpec.spec[0], curveSpec.spec[1], curveSpec.input);
  if (curveResult.ok) {
    done.contracts[curveAddress] = { verified: true, name: curveSpec.spec[1], symbol: launch.symbol, matchType: curveResult.matchType || "already", at: new Date().toISOString() };
    verified += 1;
    console.log(`verified ${launch.symbol} curve ${launch.curve} as ${curveSpec.spec[1]} (${curveResult.matchType || "already"})`);
  } else if (curveResult.error?.includes("Deployed contract not found")) {
    // Not a failure on our side. arcexplorer indexes contracts from their
    // own creation transaction, and a bonding curve is deployed by the
    // factory in an internal CREATE — so the explorer has no contract record
    // for it to attach source to, even though the address holds 13 KB of
    // code on chain. Nothing to retry until the explorer indexes internal
    // creations; recorded so this does not read as a broken verification.
    done.contracts[curveAddress] = { verified: false, reason: "explorer does not index internally created contracts", at: new Date().toISOString() };
    skipped += 1;
  } else {
    failed += 1;
    console.error(`failed ${launch.symbol} curve ${launch.curve}: ${curveResult.error}`);
  }
  await sleep(9_000);
}

done.updatedAt = new Date().toISOString();
mkdirSync(dirname(STATE), { recursive: true });
writeFileSync(STATE, JSON.stringify(done, null, 1));
console.log(`Verification pass: ${verified} newly verified, ${skipped} already done, ${failed} failed, ${launches.length} launches total`);

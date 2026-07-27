# ARC contract deployment

The contracts are intentionally not broadcast by automation. Simulate first:

```bash
forge script script/DeployArcLaunchpad.s.sol:DeployArcLaunchpad \
  --rpc-url https://arc-rpc.transferto.xyz/
```

After reviewing the simulation, the operator can broadcast with a hardware-wallet-compatible Foundry signer. Do not place a private key in the repository, shell history, or command line.

Production gates: independent review, Arc fork test at a pinned block, native-USDC decimal confirmation, explorer verification, and a small-value canary launch.

## How to deploy + verify (current pattern, proven 2026-07-27)

Every deploy below follows the same shape. Do not skip the dry-run — it is
the same command minus `--broadcast`, costs nothing, and catches a bad
constructor arg before it's permanent.

```bash
cd contracts
forge build   # must be clean before touching a live network

# 1. Dry-run (simulation only, no broadcast, no key required beyond a read)
forge script script/DeployX.s.sol:DeployX --rpc-url $RPC

# 2. Broadcast for real
export PRIVATE_KEY=<deployer key, never hard-coded, never committed>
forge script script/DeployX.s.sol:DeployX --rpc-url $RPC --broadcast

# 3. Read back the constructor-set state directly with `cast call` — never
#    trust the deploy script's own log as proof. Every deploy this session
#    was followed by a live E2E smoke test (a real supply/borrow/repay,
#    createJob/evaluate, setPolicy/payInvoice, etc.) before being wired into
#    the frontend, not just an on-chain getter check.
```

Current live RPC used for all of the above: `https://rpc.blockdaemon.testnet.arc.io`
(the Arc RPC that has held up best under repeated `eth_getLogs`/`eth_call`
load this session — public endpoints do rate-limit, `rpc-failover.mjs` exists
for scripts that need to survive that).

### Source verification

The Arcscan (Blockscout) API had a multi-day HTTP 503 outage through
2026-07-26; it resolved 2026-07-27. The working invocation, once bytecode is
on chain:

```bash
forge verify-contract <deployed-address> src/File.sol:ContractName \
  --chain 5042002 \
  --verifier blockscout \
  --verifier-url https://testnet.arcscan.app/api/ \
  --constructor-args $(cast abi-encode "constructor(<types>)" <values in order>) \
  --watch
```

Notes that cost real time to learn:

- `--verifier-url` needs the trailing `/api/` — Blockscout's v1-compatible
  Etherscan-shaped endpoint, not the bare domain or the `/api/v2/` path
  `scripts/verify-canonical-contracts.mjs` reads status from.
- `--constructor-args` must be the raw ABI-encoded hex, built with
  `cast abi-encode "constructor(<exact types>)" <values>` — get the type
  string and argument order from the actual `constructor(...)` signature in
  source, not from memory. For an array argument, quote it:
  `"[0xAddr1,0xAddr2]"`.
- If a contract shares a source file with others (e.g. `ArcPumpFactoryV8` and
  `ArcPumpCurveV8` both live in `src/ArcPumpV8.sol`), the path:name form is
  required — bare `ContractName` alone is ambiguous or wrong.
- Verification is asynchronous even on success — `--watch` polls
  `Pending in queue` → `Pass - Verified`, typically under 30 seconds. Don't
  assume failure from one "still pending" line.
- After verifying everything you touched, re-run
  `node scripts/verify-canonical-contracts.mjs` from the repo root and check
  its `verified`/`unverified` counts before calling the pass done — that's
  the tool `docs/ARCODIAN-AUDIT-READINESS.md` cites as the source of truth,
  and it also catches any address that's in `contracts.json` but was never
  actually deployed (or typo'd).

### After any redeploy, before calling it done

1. Update the address in `src/config.ts` (with a comment explaining what
   changed and why) and in `public/developers/contracts.json`.
2. Move the old address into `RETIRED_DEPLOYMENTS` (config.ts) and add a row
   to `public/developers/legacy-migration.json` — never just delete a
   superseded address; a future reader needs to know it existed and why it
   stopped being canonical.
3. `npx tsc --noEmit -p .`, `npm run build`, `npx vitest run` — all clean.
4. `forge test` (from `contracts/`) — full suite green, not just the
   contract(s) touched.
5. Cut a new timestamped release under
   `/www/wwwroot/arcodian.fun/releases/<STAMP>/`, symlink `data`/`downloads`/
   `uploads` back to `shared/` (⚠️ `rm -rf` the release's own `data/` dir
   first — Vite bundles a stale copy of `public/data/*` into `dist/data`,
   and `ln -sfn` will nest a symlink one level too deep inside it instead of
   replacing it if you don't), copy `contracts.json`/`legacy-migration.json`
   in fresh (they are not symlinked), `chown -R www:www`, then flip the
   `current` symlink.
6. Verify the new addresses reach the live site:
   `curl -s https://arcodian.fun/developers/contracts.json | jq .contracts`.

## Graduation V8 — Arc Testnet 5042002 (2026-07-19)

| Contract | Address |
|---|---|
| ArcPairFactoryV2 | `0x4067adb8499a2f4329B7eF285F9211cc882f4d37` |
| ArcPumpFactoryV8 | `0x978eB4e63f2Eabf23FB984BBdAB291f29862dB8d` |
| ArcRouter (bound to V2) | `0x3681d045a79A3290F3228575D99f26cB057b39d2` |

Treasury `0xF1CBe360b45F2E22Ab74A2c434e5602f66105CaF`, threshold 4500 USDC.

Verified on chain after deployment:

- `graduationAuthority` = the V8 pump factory, and `setGraduationAuthority`
  reverts `ALREADY_SET` **when called from the deployer** — the one privilege
  in the factory is permanently spent.
- A real launch (`SMKV8`, token `0xa149a200…861D`) cannot have its pair opened
  by anyone else: `createPair` reverts `RESERVED_UNTIL_GRADUATION` at tier 30
  *and* tier 10, and `createGraduationPair` reverts `NOT_A_CURVE`.
- An unrelated pair (EURC/USDC, tier 30) still creates normally, so the
  reservation is scoped rather than a blanket freeze.

### Dual-interface probe

`DualInterfaceProbe` `0xE0E94f60e431bc6419f79Dda9fCe75Ffc8a6B4F9`.

Graduation assumes a *contract* holding native USDC can spend the same balance
through the ERC-20 at `0x3600…` at 1e12 scale. Confirmed against the live
token: 0.05 native read as 50000 units, and an in-contract `approve` +
`transfer` of 25000 units left the probe at 25000 / 2.5e16 — both views moved
together.

**Foundry cannot test this path.** The ERC-20 delegates to a precompile at
`0x1800…` which the local EVM cannot execute (`StackUnderflow`), and
`forge script` always runs its body locally, so `--skip-simulation` does not
help. The mock-based tests prove the wiring only. This path must be checked
with `cast send` against a node.

### Not smoke-tested

A full graduation was **not** exercised. It needs the curve to accumulate 4500
USDC and the deployer holds ~10. `VIRTUAL_NATIVE` is 1000 ether and the
constructors require `threshold > VIRTUAL_NATIVE`, so there is no low-threshold
configuration of the deployed contracts that would fit the available balance.

## Graduation hub stack — 2026-07-19

Replaces the one-day-old v8 stack, whose pair registry had spent its single
graduation-authority slot on the USDC pump factory, leaving EURC no way to
graduate into ArcPair. Redeployed while the registry still held zero pairs.

| Contract | Address |
| --- | --- |
| ArcGraduationHub | `0x1709E8986B0b30B7FBaAd05971e6f8530742070A` |
| ArcPairFactoryV2 | `0xc1e7c3B9ADc079628A231636CB9c0d51478B0e87` |
| ArcPumpFactoryV8 (USDC) | `0x0876Df73010d4Cf830daFfCc6Ddc1cC852B1840B` |
| ArcPumpFactoryEurcV8 | `0xc95C0e4A098C97C5435397093CAbE0Bc2cBb677c` |
| ArcRouter | `0x5B6AAF140D477C8b397332D25cA7D7F64DA2D463` |

Retired: pump `0x978eB4e6…dB8d`, pair factory `0x4067adb8…4d37`, router
`0x3681d045…39d2`. Nothing had graduated on them.

Verified on chain, not from script output: authority == hub, hub sealed with
both factories as members, both pump factories pointing at the same registry,
router bound to it. A real EURC launch (`0x9884…7502`) was created and a
front-run attempted against it — `createPair` reverted `RESERVED_UNTIL_GRADUATION`
at both the 10 and 30 bps tiers.

Unlike the USDC path, EURC graduation runs end to end in Foundry: EURC is an
ordinary ERC-20 with no precompile, so the suite asserts the pool really holds
the collateral and that the graduated pool can be traded. **The USDC graduation
settlement path still has never executed on chain** — it needs ~4500 USDC and
the deployer holds ~30.

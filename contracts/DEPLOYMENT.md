# ARC contract deployment

The contracts are intentionally not broadcast by automation. Simulate first:

```bash
forge script script/DeployArcLaunchpad.s.sol:DeployArcLaunchpad \
  --rpc-url https://arc-rpc.transferto.xyz/
```

After reviewing the simulation, the operator can broadcast with a hardware-wallet-compatible Foundry signer. Do not place a private key in the repository, shell history, or command line.

Production gates: independent review, Arc fork test at a pinned block, native-USDC decimal confirmation, explorer verification, and a small-value canary launch.

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

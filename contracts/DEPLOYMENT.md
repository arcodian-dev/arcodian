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

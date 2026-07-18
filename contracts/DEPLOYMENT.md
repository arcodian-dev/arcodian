# ARC contract deployment

The contracts are intentionally not broadcast by automation. Simulate first:

```bash
forge script script/DeployArcLaunchpad.s.sol:DeployArcLaunchpad \
  --rpc-url https://arc-rpc.transferto.xyz/
```

After reviewing the simulation, the operator can broadcast with a hardware-wallet-compatible Foundry signer. Do not place a private key in the repository, shell history, or command line.

Production gates: independent review, Arc fork test at a pinned block, native-USDC decimal confirmation, explorer verification, and a small-value canary launch.

# Arcodian

Stablecoin-native launchpad, wallet, swap/bridge, and agent-economy infrastructure on [Circle's Arc chain](https://arc.network) — a USDC-gas L1 built for real payments, not speculation-first tokenomics.

**Live:** [arcodian.fun](https://arcodian.fun) · **X:** [@Arcodiandotfun](https://x.com/Arcodiandotfun) · **Discord:** [discord.gg/mUvcty8VAB](https://discord.gg/mUvcty8VAB)

## What's live on Arc Mainnet (chain `5042`)

Everything below is deployed and operating with real USDC — not a testnet demo.

| Surface | What it does |
|---|---|
| **Launchpad** | Fair-launch bonding-curve tokens, native-USDC priced, automatic DEX graduation on threshold — no presale, no team allocation. |
| **Swap / DEX** | Uniswap-v3-style AMM (own deployment) + external-pool routing, live order flow in the trading terminal. |
| **Bridge** | USDC in/out of Arc via Circle CCTP, wired to Ethereum, Arbitrum, Optimism, and Base mainnets. |
| **Agent Pay** | On-chain payment rails for autonomous agents — invoices, spending policies, relayed/meta-transaction payments, atomic batch settlement (EIP-712, ERC-1271 smart-wallet support). |
| **Agent Passport, Jobs & Reputation** | ERC-8004 identity, a permissionless escrow job board, and an objective on-chain reputation/validation system for agent-to-agent commerce. |
| **Lend** | Utilization-curve USDC/EUR lending market on a live Pyth oracle feed. |
| **MCP server** | [arcodian.fun/mcp](https://arcodian.fun/mcp) — reads on-chain state and returns unsigned transaction builders only. It never holds a key. |

Every contract address, verification status, and readiness gate is published and machine-readable at [arcodian.fun/developers](https://arcodian.fun/developers) — see `contracts.mainnet.json`, `mainnet-readiness.json`, and `verification-status.json`. The [Trust Center](https://arcodian.fun/contracts) explains the wiring in plain language and re-checks it live on every page load.

## Local development

```bash
npm install
npm run dev      # Vite dev server
npm run build    # production build
npx tsc -b        # typecheck
npx vitest run    # unit tests
```

Solidity contracts live in `contracts/` (Foundry):

```bash
cd contracts
forge test
```

## Repository layout

```
src/            React/Vite frontend (pages, wallet integration, config)
contracts/      Foundry contracts, tests, and deploy scripts
scripts/        Node.js indexers and keepers that feed the live app
public/         Static assets, SDKs (agentpay-sdk.mjs, gateway-erc1271-sdk.mjs), developer registry
mcp/            Arcodian MCP server (read + unsigned-tx-builder tools)
ops/systemd/    systemd units for every indexer/keeper running in production
```

## Safety principles

- The frontend never stores a key or custodies funds — every state-changing action is a wallet-signed transaction the user approves.
- Arc Mainnet (`5042`) and Arc Testnet (`5042002`) are configured independently in `src/config.ts` and are never conflated.
- New product surfaces stay gated behind explicit on-chain bytecode checks and, where noted, a signed-off feature flag — see `DEPLOYMENT.md`.
- Quote and route providers fail closed: no route found means no swap offered, never a best-guess fallback.

## Contributing

This repository is under active development. Open an issue or reach out on [Discord](https://discord.gg/mUvcty8VAB) before sending a pull request.

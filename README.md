# ARC Markets

Portable non-custodial discovery, bridge, swap, and staged launchpad interface for official Arc Testnet (`5042002`).

## Current state

- Explore: searchable verified-asset board, ready for factory event indexing.
- Wallets: EIP-6963 discovery for MetaMask, OKX, Zerion, Bitget, Rabby, Coinbase, and other compliant injected wallets; active chain updates automatically.
- Bridge and Swap: wallet-signed route previews; testnet availability is fail-closed.
- Launchpad: Pump v2 candidate uses a fixed 1B supply, native-USDC bonding curve, automatic ARC DEX graduation, and LP minted directly to the burn address.
- Legacy fixed-sale canary: `0x40147884E6992cee1f7030d1263C692a4Cbae942`; retained for provenance but retired from launch creation.
- Canonical engine: **ArcPumpSuiteV6** `0x8F4FAF89f3d6f2f4Ad535df7faF3B5787BA35020` (Launch Factory `0x454529204A0B0846Cc0dF37CFdFf3De8541B36e4`, ARC DEX Factory `0xC933eCeb3Ca62f31E7DD1D2538e6cfE879c5bDdA`), deployed 2026-07-16 with accrued protocol fees + treasury-only pull withdrawal (resolves audit finding A-01). V5 suite `0x6601aD6C8a32cB5e1217d1304457e2C9F8778094` stays live for its historical markets. See `PUMP_ARCHITECTURE.md`.
- No private keys, custody, fee wallet, or production contract addresses are stored in this repository.

## Official Arc Testnet metadata

- Chain ID: `5042002` (`0x4cef52`)
- Native asset: USDC, 6 decimals
- LI.FI native address: `0x3600000000000000000000000000000000000000`
- RPC: `https://rpc.testnet.arc.network/`
- Explorer: `https://testnet.arcscan.app`
- Faucet: `https://faucet.circle.com`

## Local development

```bash
npm install
npm run dev
```

Production check:

```bash
npm run build
```

## Domain portability

No product route is tied to `arc.tensoriumlabs.com`. For a new domain, set `VITE_PUBLIC_ORIGIN`, build, point the webroot to `dist`, and issue TLS. See `DEPLOYMENT.md`.

## Production gates

Before public deployment: independent contract audit, invariant/fork tests, production dependency remediation, official Uniswap v4 Arc address verification, token-risk disclosures, and small-value live tests.

## Production ops notes (2026-07-16)

- **Code splitting**: `src/App.tsx` is decomposed into `src/shared.tsx` + `src/pages/{Market,Profile,Landing,TrustCenter}.tsx`, loaded via `React.lazy`. Circle App Kit, WalletConnect, and the deploy bytecode (`src/generated/arcPumpSuiteBytecode.ts`) are dynamic imports — the initial route ships ~160 KB gzip (index + ethers) instead of the former 574 KB monolith chunk.
- **WalletConnect**: `VITE_WALLETCONNECT_PROJECT_ID` in `.env.production` is intentionally empty. Register at https://cloud.reown.com (free), paste the Project ID, rebuild, release. UI hides the WalletConnect button until set.
- **Indexing**: production uses the systemd pair `arcodian-indexer.timer` (market index, ~90s) + `arcodian-live-tape.service` (sub-second tape). Candles are derived client-side from indexed trades. docs.arc.io also lists managed indexers (Envio, Goldsky, The Graph) — adopting one needs an external account and is optional at current volume; revisit if trade volume outgrows the file-based index.
- **UI v2 foundation**: token layer + 5-item mobile dock + focus-visible/reduced-motion/touch-target pass appended at the end of `src/styles.css` (see `UI_UX_AUDIT_2026-07-16.md` for the staged remainder).

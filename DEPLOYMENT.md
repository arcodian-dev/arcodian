# ARC deployment

The build is domain-agnostic and uses SPA routes (`/explore`, `/swap`, `/bridge`, `/launch`).

## New domain checklist

1. Point the domain A/AAAA record to the server.
2. Copy `.env.example` to `.env.production` and set `VITE_PUBLIC_ORIGIN`.
3. Run `npm ci && npm run build`.
4. Publish `dist/` to a versioned release directory.
5. Switch the webroot symlink atomically and configure SPA fallback to `index.html`.
6. Issue TLS, then smoke-test all four routes and wallet chain switching.

Keep the previous release directory and webroot target until the new release passes checks. Rollback is an atomic symlink switch to that previous release.

## Shared live-data symlinks (required on every new release)

The webroot `data` and `uploads` directories must be symlinked (whole directory, not copied) to `/www/wwwroot/arcodian.fun/shared/{data,uploads}` so systemd-timer indexers keep serving live data across deploys without a rebuild. **`dist/` ships a real `data/` directory of its own (build-time seed files), so `ln -sfn shared/data "$REL/data"` silently nests the symlink inside it (`$REL/data/data`) instead of replacing it** — always `rm -rf "$REL/data"` first. (Found and fixed live 2026-08-07: a deploy did exactly this, so `mainnet-live-tape.json` — written once into `current/data/` by that service's `ExecStartPost` only at its own startup, not on every tick — never reached the new release, and the trading terminal silently fell back to its "Offline" indicator until the symlink was corrected.)

`developers/` is copied into each release from `public/developers/` at build time (static docs + seed JSON), but six files under it are continuously rewritten by indexer timers and MUST be re-symlinked into every new release or they freeze at deploy time and silently serve stale data to real users (agent/reputation/job pages read these client-side):

```
developers/agents.json               -> shared/developers/agents.json
developers/agents.json.state.json    -> shared/developers/agents.json.state.json
developers/jobs.json                 -> shared/developers/jobs.json
developers/jobs.json.state.json      -> shared/developers/jobs.json.state.json
developers/reputation.json           -> shared/developers/reputation.json
developers/verification-status.json  -> shared/developers/verification-status.json
```

Run `node scripts/indexer-dr-drill.mjs` after any deploy — it fails closed if a served file diverges from its shared source. (Found and fixed 2026-08-07: these six files were never symlinked, so `/developers/agents.json` had been serving a 1-record snapshot from the last deploy while the live indexer had reached 12,700+ records.)

## Safety gates

- Arc Mainnet (chain 5042) is LIVE with real USDC and real user funds; Arc Testnet (chain 5042002) is separate — never conflate the two or label mainnet assets as test assets.
- Never store a seed phrase or private key in the repository or webroot.
- Keep Launch public actions locked until the deployed factory bytecode is verified.
- Fail closed when quote providers return no route.

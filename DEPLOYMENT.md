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

## Safety gates

- Arc is currently testnet-only; never label test assets as real funds.
- Never store a seed phrase or private key in the repository or webroot.
- Keep Launch public actions locked until the deployed factory bytecode is verified.
- Fail closed when quote providers return no route.

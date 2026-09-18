# arcodian.fun — false-positive phishing reports (drafts)

Send these from the project owner's own accounts. Evidence re-checked 2026-09-18.

## Evidence to attach (same for every vendor)

- Domain: `arcodian.fun`. All older subdomains (market., swap., bridge., docs., wallet., lend.) now 301 to paths on this one domain.
- Public blocklists, all clean as of 2026-09-18:
  - MetaMask eth-phishing-detect: not listed
  - ScamSniffer scam-database: not listed
  - ChainPatrol: `UNKNOWN / not-found`
  - GoPlus phishing_site API: `phishing_site: 0`
  - Phantom blocklist: not listed
- The site makes no wallet request (connect, sign, approve) until the user clicks. It never asks for seed phrases or private keys. Every transaction is built client-side and signed in the user's own wallet.
- Security headers: strict Content-Security-Policy (`script-src 'self'`), HSTS, `X-Frame-Options: DENY`.
- Contracts are source-verified on Circle's official Arc explorer, https://explorer.arc.io (launch factory `0xDFE3e7C6e139860d88f13FCCB6A1d9dCEE2211e2`), and on Sourcify.
- Official socials: https://x.com/Arcodiandotfun · https://discord.gg/mUvcty8VAB
- Contract list with live wiring checks: https://arcodian.fun/contracts

---

## 1. Blockaid (used by Zerion and several other wallets)

Where: https://report.blockaid.io (choose the false-positive / "my dApp is flagged" option)

> **Subject:** False positive — arcodian.fun flagged as malicious
>
> Hello Blockaid team,
>
> I operate arcodian.fun, a non-custodial token launchpad and market on Arc Mainnet (Circle's L1, chain ID 5042). Users on Zerion and OKX Wallet desktop see arcodian.fun flagged as a phishing or malicious site. We believe this is a false positive and ask you to review it.
>
> What the site does: users launch tokens into their own Uniswap V4 pools and trade them. It also offers a USDC bridge using Circle CCTP. Nothing on the site holds user funds. Every transaction is built client-side and signed in the user's own wallet. The site makes no wallet request until the user clicks, and it never asks for a seed phrase or private key.
>
> Verification:
> - Contracts are source-verified on Circle's official explorer, https://explorer.arc.io. The launch factory is 0xDFE3e7C6e139860d88f13FCCB6A1d9dCEE2211e2. Every canonical contract is listed at https://arcodian.fun/contracts.
> - arcodian.fun is not listed by MetaMask eth-phishing-detect, ScamSniffer, ChainPatrol, GoPlus or Phantom.
> - Official accounts: https://x.com/Arcodiandotfun and https://discord.gg/mUvcty8VAB
>
> The domain is new (registered July 2026) and uses the "Arc" name because it is built on the Arc network. We are not affiliated with Circle and do not present ourselves as Circle. If any specific page or transaction pattern triggered the flag, please tell us and we will change it.
>
> Thank you,
> [name] — arcodian.fun

---

## 2. OKX Wallet

Where: OKX app or extension → Support / Help Center → chat with support (ask for the Web3 wallet security team). If they want email, use the support address shown in the OKX Help Center.

> **Subject:** OKX Wallet flags arcodian.fun as phishing — false positive
>
> Hello OKX Web3 team,
>
> OKX Wallet (desktop extension) shows a phishing warning when users open https://arcodian.fun. I run this site and believe the warning is a false positive. Please review and remove the flag.
>
> arcodian.fun is a non-custodial token launchpad and market on Arc Mainnet (chain ID 5042). Users sign every transaction in their own wallet. The site never requests a seed phrase or private key, and it sends no wallet request before the user clicks.
>
> - Contracts, source-verified on Circle's official explorer: https://explorer.arc.io (launch factory 0xDFE3e7C6e139860d88f13FCCB6A1d9dCEE2211e2); full list at https://arcodian.fun/contracts
> - Not listed by MetaMask eth-phishing-detect, ScamSniffer, ChainPatrol, GoPlus or Phantom
> - Official: https://x.com/Arcodiandotfun · https://discord.gg/mUvcty8VAB
>
> If a specific behaviour triggered the warning, please share it and we will fix it.
>
> Thank you,
> [name] — arcodian.fun

---

## 3. Zerion

Where: Zerion app → Settings → Help / Contact support (or the support email in the Zerion Help Center). Zerion's site warnings come from Blockaid, so also send report 1.

> **Subject:** Zerion shows a phishing warning for arcodian.fun — false positive
>
> Hello Zerion team,
>
> Zerion (desktop) shows a malicious-site warning on https://arcodian.fun. I operate the site and believe the warning is a false positive. I have also reported it to Blockaid.
>
> arcodian.fun is a non-custodial token launchpad and market on Arc Mainnet (chain ID 5042). All transactions are signed in the user's own wallet. The site never asks for a seed phrase or private key and makes no wallet request until the user clicks.
>
> - Contracts, source-verified on Circle's official explorer: https://explorer.arc.io (launch factory 0xDFE3e7C6e139860d88f13FCCB6A1d9dCEE2211e2); list at https://arcodian.fun/contracts
> - Not listed by MetaMask eth-phishing-detect, ScamSniffer, ChainPatrol, GoPlus or Phantom
> - Official: https://x.com/Arcodiandotfun · https://discord.gg/mUvcty8VAB
>
> Could you help escalate the review with your security provider?
>
> Thank you,
> [name] — arcodian.fun

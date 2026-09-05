# Agent Pay on Arc Mainnet

Agent Pay Mainnet currently uses the deployed non-identity V2 flow. It gives
each connected wallet an isolated vault with an immutable owner and bounded
agent permissions. The production UI does not silently migrate existing vaults
or create a V6 vault.

## Mainnet contracts

- Network: Arc Mainnet, chain `5042`
- ArcPay settlement: `0x69af28c7daddCFf7F9BC2DCfEd244c9696f3A9A2`
- Agent Pay V2 factory: `0xbFb5b17daE316f1d73f8A7ED456122d132BC5DB6`
- Additive V6 factory: `0x304f7ACFDB096358d89Da8762721207e0B5B1433`

All three redeployed 2026-09-05: the original ArcPay
(`0x1dE9822D79aFdd53f9270503d16080F9ecbFdB7C`) had its immutable treasury set
to the deployer EOA instead of the multisig, and both factories held an
immutable reference to that same contract — fixing the factories meant
redeploying them too. Both original factories reported `vaultCount() == 0`
on mainnet, so no vault (and therefore no payment) had ever gone through
either one; nothing needed migrating.

## User flow

1. Connect a wallet on Arc Mainnet.
2. The page reads `vaultOf(owner)` from the V2 factory.
3. If no vault exists, the owner may call `createVault()` with optional native
   USDC funding. The factory creates one isolated vault for that owner.
4. The owner sets an agent-address policy: per-payment cap, daily cap, expiry,
   and enabled state.
5. The owner allowlists each merchant address separately.
6. The agent calls `payInvoice(invoiceId, merchant, amount, expiry, memoHash)`.
   The vault enforces owner, merchant, amount, daily-limit, expiry, and balance
   checks before forwarding the exact payment to ArcPay.
7. The owner can withdraw funds from the vault at any time; the factory has no
   withdrawal path and cannot control user vault funds.

Arc native USDC uses 18 decimals for value and gas. The UI and SDK use the same
unit at the transaction boundary.

## Network boundaries

The ERC-8004 Passport, Jobs, Reputation/Validation, V5 relayed invoices, and
V6 identity-aware batch vault flows remain on Arc Testnet. The V6 mainnet
factory is additive only: no vault is created automatically and production UI
does not route to it until Gateway, migration, and independent-audit gates pass.

Gateway ERC-1271 integration is testnet-only because Circle's supported-chain
list does not currently include Arc Mainnet.

### Official dependency evidence checked 2026-08-05

- The official `erc-8004/erc-8004-contracts` repository lists the Arc
  Testnet Identity and Reputation registries, but does not list an Arc
  Mainnet registry deployment. A GitHub repository or a testnet address is
  not evidence that the registry exists on chain `5042`.
- The official `circlefin/evm-gateway-contracts` repository contains the
  Gateway contract source and deployment tooling, but its public deployment
  material does not establish an Arc Mainnet Gateway deployment.
- Agent Pay therefore keeps Passport, identity-aware V6 flows, and Gateway
  authorization disabled on Mainnet until the dependency addresses and live
  bytecode are independently verified.

## Safety model

The owner signs every policy, merchant permission, funding, and withdrawal
transaction. Arcodian does not hold the vault key, cannot change policy, and
cannot withdraw funds. Always confirm chain `5042`, target address, amount, and
merchant before signing.

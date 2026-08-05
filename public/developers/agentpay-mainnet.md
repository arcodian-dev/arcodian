# Agent Pay on Arc Mainnet

Agent Pay Mainnet currently uses the deployed non-identity V2 flow. It gives
each connected wallet an isolated vault with an immutable owner and bounded
agent permissions. The production UI does not silently migrate existing vaults
or create a V6 vault.

## Mainnet contracts

- Network: Arc Mainnet, chain `5042`
- ArcPay settlement: `0x1dE9822D79aFdd53f9270503d16080F9ecbFdB7C`
- Agent Pay V2 factory: `0x4E3fDc7ddA063e8d629C7140e1D7ace574275c69`
- Additive V6 factory: `0x69d7eE9672fE5b7660B6a13D3B6f767C7E8576dB`

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

## Safety model

The owner signs every policy, merchant permission, funding, and withdrawal
transaction. Arcodian does not hold the vault key, cannot change policy, and
cannot withdraw funds. Always confirm chain `5042`, target address, amount, and
merchant before signing.

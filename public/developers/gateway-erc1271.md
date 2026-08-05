# Gateway ERC-1271 integration

The public helper at `/gateway-erc1271-sdk.mjs` builds and signs Circle Gateway
ERC-1271 transfer payloads for Arc Testnet. The helper never stores private keys,
submits transfers, or silently signs on behalf of an agent.

## Current scope

- Network: Arc Testnet (`chainId 5042002`, Gateway domain `26`)
- Gateway API: `https://gateway-api-testnet.circle.com/v1/transfer`
- Request flag: `contractSigner: true`
- Source signer: the Agent Pay vault contract implementing `isValidSignature`
- Signing authority: the vault owner or its ERC-1271 owner contract
- Mainnet: disabled until Circle lists Arc Mainnet as a supported Gateway chain

The flow is:

1. Build the typed `BurnIntent` and nested `TransferSpec`.
2. Sign the typed data with the owner authority for the Agent Pay vault.
3. Send the opaque signature and `contractSigner: true` to Circle's testnet
   `/v1/transfer` endpoint using a server-side Circle API credential.
4. Submit the returned attestation and signature through `gatewayMint` on the
   destination chain.

The adapter is an unsigned integration surface. Production activation still
requires Circle API credentials, a real testnet E2E receipt, replay/expiry
negative tests, and an independent security review.

## Arcodian Agent Kit network status

- Arc Mainnet: base Arc Pay and non-identity Agent Pay V2 are deployed and
  available through `ARC_AGENT_PAY_MAINNET`.
- Arc Testnet: Passport, Jobs, Reputation, V5 relayed invoices, and V6 batch
  vault flows are the active identity-aware development stack.
- Arc Mainnet V6: factory deployed additively, but no vault is auto-created and
  the production UI does not route to it yet.

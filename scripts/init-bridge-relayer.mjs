// Creates the dedicated Arc bridge relayer key once.
// The private key is written only to the mode-0600 server config; stdout
// contains the public funding address and never the secret.

import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { Wallet } from "ethers";

const path = process.env.BRIDGE_RELAYER_CONFIG || "/root/.config/arcodian/bridge-relayer.json";
const wallet = Wallet.createRandom();
const config = {
  privateKey: wallet.privateKey,
  arcRpc: "https://5042.rpc.thirdweb.com",
  sourceRpcs: {
    "1": "https://ethereum-rpc.publicnode.com",
    "10": "https://mainnet.optimism.io",
    "42161": "https://arb1.arbitrum.io/rpc",
    "8453": "https://mainnet.base.org",
  },
  routers: {},
};

await mkdir(dirname(path), { recursive: true, mode: 0o700 });
const file = await open(path, "wx", 0o600);
try {
  await file.writeFile(`${JSON.stringify(config, null, 2)}\n`);
} finally {
  await file.close();
}
process.stdout.write(`${wallet.address}\n`);

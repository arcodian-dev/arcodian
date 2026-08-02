// Updates only public router addresses in the server-only relayer config while
// preserving the private key. The rewritten file remains mode 0600.

import { readFile, writeFile, rename } from "node:fs/promises";

const path = process.env.BRIDGE_RELAYER_CONFIG || "/root/.config/arcodian/bridge-relayer.json";
const config = JSON.parse(await readFile(path, "utf8"));
config.routers = {
  "1": "0xA3c5cEf9f54b9eBc7c15Fd768a30Aa4815FC0bFA",
  "10": "0xA3c5cEf9f54b9eBc7c15Fd768a30Aa4815FC0bFA",
  "42161": "0xA3c5cEf9f54b9eBc7c15Fd768a30Aa4815FC0bFA",
  "8453": "0xA3c5cEf9f54b9eBc7c15Fd768a30Aa4815FC0bFA",
};
const temp = `${path}.tmp`;
await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
await rename(temp, path);

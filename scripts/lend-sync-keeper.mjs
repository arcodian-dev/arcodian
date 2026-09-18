// Keeps Arc Lend's synced EUR/USD price fresh on Arc Mainnet.
//
// ArcLendV2 prices collateral from lastGoodPrice, which only moves when
// someone calls syncOracle() (anyone may). Borrows and liquidations revert
// once it is older than the market's maxOracleAge (6 hours), so this keeper
// syncs when the stored price is getting old or the oracle has moved enough
// to matter — not on every run, because each sync costs gas.
//
// Server-only config: /root/.config/arcodian/lend-keeper.json { "PRIVATE_KEY": "0x…" }
import { readFile } from "node:fs/promises";
import { Contract, JsonRpcProvider, Wallet } from "ethers";

const MARKET = process.env.ARC_LEND_ADDRESS || "0x36Fe4144DD0154338b90FeE3303663C77b42E8DB";
const RPC = process.env.ARC_MAINNET_RPC_URL || "https://rpc.blockdaemon.mainnet.arc.io";
const MAX_AGE_BEFORE_SYNC = Number(process.env.LEND_SYNC_AFTER_SECONDS || 2 * 3600);
const MOVE_BPS = BigInt(process.env.LEND_SYNC_MOVE_BPS || 30);

const config = JSON.parse(await readFile(process.env.LEND_KEEPER_CONFIG || "/root/.config/arcodian/lend-keeper.json", "utf8"));
const provider = new JsonRpcProvider(RPC, 5042, { staticNetwork: true, batchMaxCount: 1 });
const signer = new Wallet(config.PRIVATE_KEY, provider);
const market = new Contract(MARKET, [
  "function oracle() view returns (address)",
  "function lastGoodPrice() view returns (uint256)",
  "function lastGoodPriceAt() view returns (uint64)",
  "function syncOracle()",
], signer);
const oracle = new Contract(await market.oracle(), ["function price() view returns (uint256, uint64)"], provider);

const [stored, storedAt, [next]] = await Promise.all([market.lastGoodPrice(), market.lastGoodPriceAt(), oracle.price()]);
const now = Math.floor(Date.now() / 1000);
const age = now - Number(storedAt);
const moveBps = stored > 0n ? ((next > stored ? next - stored : stored - next) * 10_000n) / stored : 10_000n;

if (age < MAX_AGE_BEFORE_SYNC && moveBps < MOVE_BPS) {
  console.log(JSON.stringify({ action: "skip", ageSeconds: age, moveBps: Number(moveBps), price: next.toString() }));
  process.exit(0);
}
const tx = await market.syncOracle();
await tx.wait();
console.log(JSON.stringify({ action: "synced", tx: tx.hash, ageSeconds: age, moveBps: Number(moveBps), price: next.toString(), keeperBalance: (await provider.getBalance(signer.address)).toString() }));

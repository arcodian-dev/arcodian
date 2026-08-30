import { Contract, Wallet } from "ethers";
import { healthyProvider } from "./rpc-failover.mjs";

const PYTH = process.env.PYTH_ADDRESS || "0x2880aB155794e7179c9eE2e38200202908C17B43";
const FEED = (process.env.PYTH_EUR_USD_ID || "a995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b").replace(/^0x/, "");
const MARKET = process.env.ARC_LEND_ADDRESS;
if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY is required");
if (!MARKET && process.env.PYTH_UPDATE_ONLY !== "1") throw new Error("ARC_LEND_ADDRESS is required");

// Hermes started requiring an API key on every request some time between
// 2026-07-31 (this keeper last confirmed working) and 2026-08-25 (last
// successful on-chain price update) — a Circle/Pyth-side breaking change,
// not anything this script did. Every unauthenticated request now gets a
// blanket 401, which crash-looped this keeper every ~3 minutes for 5 days
// straight until the oracle exceeded ArcLendV2's 90h maxOracleAge and
// OracleStale() started reverting borrows on the live /lend page. Get a key
// at https://docs.pyth.network (Hermes docs) and set PYTH_API_KEY in
// /root/.config/arcodian/lend-keeper.json or the unit's Environment= lines.
const headers = process.env.PYTH_API_KEY ? { Authorization: `Bearer ${process.env.PYTH_API_KEY}` } : {};
const response = await fetch(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${FEED}&encoding=hex`, { headers });
if (!response.ok) throw new Error(`Hermes HTTP ${response.status}${process.env.PYTH_API_KEY ? "" : " (no PYTH_API_KEY set — Hermes requires one as of 2026-08)"}`);
const payload = await response.json();
const updates = (payload?.binary?.data || []).map((value) => `0x${value.replace(/^0x/, "")}`);
if (!updates.length) throw new Error("Hermes returned no update data");

// Select a healthy transport before signing. A submitted transaction is never
// blindly replayed on another RPC because a timeout does not prove it failed.
const { provider, url: rpc, candidates } = await healthyProvider();
const signer = new Wallet(process.env.PRIVATE_KEY, provider);
const pyth = new Contract(PYTH, [
  "function getUpdateFee(bytes[] updateData) view returns(uint256)",
  "function updatePriceFeeds(bytes[] updateData) payable"
], signer);
const fee = await pyth.getUpdateFee(updates);
const updateTx = await pyth.updatePriceFeeds(updates, { value: fee });
await updateTx.wait();
if (process.env.PYTH_UPDATE_ONLY === "1") {
  console.log(JSON.stringify({ updateTx: updateTx.hash }));
  process.exit(0);
}
const market = new Contract(MARKET, [
  "function syncOracle()",
  "function lastGoodPrice() view returns(uint256)",
  "function lastGoodPriceAt() view returns(uint64)"
], signer);
const syncTx = await market.syncOracle();
await syncTx.wait();
console.log(JSON.stringify({ market: MARKET, rpc: new URL(rpc).hostname, rpcCandidates: candidates, updateTx: updateTx.hash, syncTx: syncTx.hash, price: (await market.lastGoodPrice()).toString(), updatedAt: Number(await market.lastGoodPriceAt()) }));

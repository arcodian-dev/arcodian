#!/usr/bin/env node
// Public, read-only Arc Pay merchant metrics derived exclusively from finalized
// InvoicePaid and PaymentRefunded events. No customer metadata is stored.
import { AbiCoder, Contract, JsonRpcProvider, id } from "ethers";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const RPC = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network/";
const ARC_PAY = process.env.ARC_PAY_ADDRESS || "0x5E3d1b63213B8608539116d1c6248a36819684b5";
const OUT = process.env.ARC_PAY_STATS_OUTPUT || "/www/wwwroot/arcodian.fun/shared/data/arcpay-stats.json";
const KNOWN_DEPLOY_BLOCK = 52_739_844;
const CHUNK = 9_000;
const provider = new JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
const coder = AbiCoder.defaultAbiCoder();
const PAID = id("InvoicePaid(bytes32,address,address,uint256,uint256,uint256,bytes32)");
const REFUNDED = id("PaymentRefunded(bytes32,address,address,uint256)");

async function deployBlock(tip) {
  let low = 0, high = tip;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((await provider.getCode(ARC_PAY, middle)) !== "0x") high = middle;
    else low = middle + 1;
  }
  return low;
}

// Both event types in one windowed sweep: the node caps eth_getLogs at a
// 10,000-block range, so requests — not bytes — are the cost that matters.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function logs(topics, from, to) {
  const found = [];
  for (let start = from; start <= to; start += CHUNK) {
    const params = { address: ARC_PAY, topics: [topics], fromBlock: start, toBlock: Math.min(to, start + CHUNK - 1) };
    for (let attempt = 0; ; attempt++) {
      try { found.push(...await provider.getLogs(params)); break; }
      catch (error) {
        if (attempt >= 5 || !/limit reached|rate|429|-32011/i.test(String(error?.error?.message || error?.info?.responseBody || error?.message))) throw error;
        await sleep(1500 * (attempt + 1)); // back off through the RPC request limit
      }
    }
    await sleep(120); // stay comfortably under the public endpoint rate
  }
  return found;
}

// Raw events are cached beside the public file so each run only reads the blocks
// added since the last one. Arc makes ~1.7 blocks/second; replaying the whole
// history every minute is what tripped the RPC request limit.
const STATE = `${OUT}.state.json`;
const MAX_CATCHUP = Number(process.env.ARC_PAY_MAX_CATCHUP || 30_000);
function loadState() {
  try {
    const state = JSON.parse(readFileSync(STATE, "utf8"));
    if (Number.isFinite(state?.indexedBlock) && Array.isArray(state.payments) && Array.isArray(state.refunds)) return state;
  } catch { /* first run */ }
  return null;
}

const addressTopic = (topic) => `0x${topic.slice(-40)}`.toLowerCase();
const usd = (value) => Number(value) / 1e18;

async function main() {
  const tip = await provider.getBlockNumber();
  const state = loadState();
  const deployFrom = process.env.ARC_PAY_DEPLOY_BLOCK ? Number(process.env.ARC_PAY_DEPLOY_BLOCK) : ARC_PAY.toLowerCase() === "0x5e3d1b63213b8608539116d1c6248a36819684b5" ? KNOWN_DEPLOY_BLOCK : await deployBlock(tip);
  const checkpoint = state ? state.indexedBlock + 1 : deployFrom;
  const from = Math.max(checkpoint, tip - MAX_CATCHUP);
  const fresh = from <= tip ? await logs([PAID, REFUNDED], from, tip) : [];
  const paidLogs = fresh.filter((log) => log.topics[0] === PAID);
  const refundLogs = fresh.filter((log) => log.topics[0] === REFUNDED);
  const blockNumbers = [...new Set([...paidLogs, ...refundLogs].map((log) => log.blockNumber))];
  const timestamps = new Map();
  for (const blockNumber of blockNumbers) timestamps.set(blockNumber, Number((await provider.getBlock(blockNumber))?.timestamp || 0));

  const freshPayments = paidLogs.map((log) => {
    const [gross, merchantNet, fee] = coder.decode(["uint256", "uint256", "uint256", "bytes32"], log.data);
    return {
      invoiceId: log.topics[1], payer: addressTopic(log.topics[2]), merchant: addressTopic(log.topics[3]),
      gross: gross.toString(), merchantNet: merchantNet.toString(), fee: fee.toString(),
      block: log.blockNumber, timestamp: timestamps.get(log.blockNumber) || 0, tx: log.transactionHash,
    };
  });
  const freshRefunds = refundLogs.map((log) => {
    const [amount] = coder.decode(["uint256"], log.data);
    return { invoiceId: log.topics[1], merchant: addressTopic(log.topics[2]), payer: addressTopic(log.topics[3]), amount: amount.toString(), block: log.blockNumber, timestamp: timestamps.get(log.blockNumber) || 0, tx: log.transactionHash };
  });

  // Merge with everything already indexed, de-duplicating on tx + invoice.
  const mergeUnique = (older, newer) => {
    const seen = new Set(older.map((row) => `${row.tx}:${row.invoiceId}`));
    const out = [...older];
    for (const row of newer) {
      const key = `${row.tx}:${row.invoiceId}`;
      if (!seen.has(key)) { seen.add(key); out.push(row); }
    }
    return out.sort((a, b) => a.block - b.block);
  };
  const payments = mergeUnique(state?.payments || [], freshPayments);
  const refunds = mergeUnique(state?.refunds || [], freshRefunds);
  const refunded = new Set(refunds.map((item) => item.invoiceId.toLowerCase()));
  const merchants = new Map();
  for (const payment of payments) {
    const row = merchants.get(payment.merchant) || { merchant: payment.merchant, payments: 0, volume: 0n, net: 0n, fees: 0n, refunds: 0, refundedVolume: 0n };
    row.payments += 1; row.volume += BigInt(payment.gross); row.net += BigInt(payment.merchantNet); row.fees += BigInt(payment.fee);
    merchants.set(payment.merchant, row);
  }
  for (const refund of refunds) {
    const row = merchants.get(refund.merchant) || { merchant: refund.merchant, payments: 0, volume: 0n, net: 0n, fees: 0n, refunds: 0, refundedVolume: 0n };
    row.refunds += 1; row.refundedVolume += BigInt(refund.amount); merchants.set(refund.merchant, row);
  }
  const gross = payments.reduce((sum, item) => sum + BigInt(item.gross), 0n);
  const fees = payments.reduce((sum, item) => sum + BigInt(item.fee), 0n);
  const refundedVolume = refunds.reduce((sum, item) => sum + BigInt(item.amount), 0n);
  const payload = {
    version: 1, chainId: 5_042_002, contract: ARC_PAY, indexedAt: new Date().toISOString(), indexedBlock: tip,
    totals: { payments: payments.length, merchants: merchants.size, grossVolumeUsd: usd(gross), merchantNetUsd: usd(gross - fees), protocolFeesUsd: usd(fees), refunds: refunds.length, refundedVolumeUsd: usd(refundedVolume), successfulInvoices: payments.filter((item) => !refunded.has(item.invoiceId.toLowerCase())).length },
    merchants: [...merchants.values()].map((row) => ({ ...row, volume: usd(row.volume), net: usd(row.net), fees: usd(row.fees), refundedVolume: usd(row.refundedVolume) })).sort((a, b) => b.volume - a.volume),
    recent: payments.slice(-1000).reverse().map((item) => ({ ...item, grossUsd: usd(BigInt(item.gross)), refunded: refunded.has(item.invoiceId.toLowerCase()) })),
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(payload, null, 2));
  writeFileSync(STATE, JSON.stringify({ indexedBlock: tip, payments, refunds }));
  console.log(`Arc Pay stats: ${payments.length} payments, ${merchants.size} merchants, $${payload.totals.grossVolumeUsd.toFixed(2)} volume`);
  await provider.destroy();
}

main().catch((error) => { console.error(error); process.exit(1); });

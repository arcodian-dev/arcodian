#!/usr/bin/env node
// Mainnet counterpart to treasury-stats.mjs, which only ever indexed Arc
// Testnet (hardcoded chainId 5042002, testnet.arcscan.app) even though the
// canonical treasury address holds real value on Arc Mainnet too -- found
// live 2026-08-07: treasury had 7.33 real USDC on mainnet, entirely invisible
// on the public /treasury page. No mainnet block-explorer API is reliable
// (arc.exploreme.pro currently serves its own maintenance page instead of an
// API), so this scans Transfer events on the native USDC ERC-20 view
// precompile directly via RPC, incrementally from the last indexed block.
import { Contract, JsonRpcProvider, formatUnits, Interface } from "ethers";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const TREASURY = (process.env.ARC_TREASURY || "0xF1CBe360b45F2E22Ab74A2c434e5602f66105CaF").toLowerCase();
const RPC = process.env.ARC_MAINNET_RPC_URL || "https://arcodian.fun/api/rpc-mainnet.php";
const USDC = "0x3600000000000000000000000000000000000000";
const OUT = process.env.TREASURY_STATS_OUTPUT || "/www/wwwroot/arcodian.fun/shared/data/treasury-mainnet.json";
const STATE = `${OUT}.state.json`;
const CHUNK = 40_000;
// Arc Mainnet's earliest known Arcodian-relevant block (first mainnet deploy
// broadcast, task #40) -- no point scanning from genesis for a chain whose
// only activity we care about starts here.
const GENESIS_FLOOR = 13_100_000; // just before the first mainnet Arcodian deploy (DeployArcBridgeRouter, block 13,126,352)

const provider = new JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
const erc20 = ["function balanceOf(address) view returns(uint256)"];
const iface = new Interface(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const TOPIC = iface.getEvent("Transfer").topicHash;

// Known Arc Mainnet contracts that legitimately forward USDC to the
// treasury -- kept in sync with src/config.ts (CCTP_MAINNET_FEE_ROUTER[5042],
// ARC_MAINNET_CONTRACTS). Anything not on this list stays "Unattributed"
// rather than guessed at, matching treasury-stats.mjs's own policy.
const KNOWN_SOURCES = new Map([
  ["0xc35deb937f5056a0e034f10e21094878485caee7", "Bridge fee router (CCTP)"],
  ["0x1de9822d79afdd53f9270503d16080f9ecbfdb7c", "Arc Pay"],
  ["0x5e3d1b63213b8608539116d1c6248a36819684b5", "Market / DEX (pair factory)"],
  ["0x508fda9f366e734a45fe7bc3a98f2909754633b7", "Market / DEX (USDC factory)"],
  ["0x6e1d1a09b07a4022b535269434c16a3452e195f9", "Launchpad V9"],
  ["0xcec317ca96b7e55fa0f9f7c243cdb0ee6bc19ced", "Launchpad V10"],
  ["0xe4664b28cb0624860aaee28e573697473f2bf46e", "External V3 fee router"],
]);

function loadState() { try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return { lastBlock: GENESIS_FLOOR - 1, entries: [] }; } }

function sourceLabel(counterparty) {
  const addr = counterparty.toLowerCase();
  if (KNOWN_SOURCES.has(addr)) return ["Revenue", KNOWN_SOURCES.get(addr)];
  return ["Unknown", "Unattributed"];
}

async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  const state = loadState();
  const tip = await provider.getBlockNumber();
  const fromBlock = Math.max(state.lastBlock + 1, GENESIS_FLOOR);
  const entries = state.entries || [];

  if (fromBlock <= tip) {
    const treasuryTopic = "0x" + TREASURY.slice(2).padStart(64, "0");
    for (let start = fromBlock; start <= tip; start += CHUNK) {
      const end = Math.min(start + CHUNK - 1, tip);
      const [inbound, outbound] = await Promise.all([
        provider.getLogs({ address: USDC, topics: [TOPIC, null, treasuryTopic], fromBlock: start, toBlock: end }),
        provider.getLogs({ address: USDC, topics: [TOPIC, treasuryTopic, null], fromBlock: start, toBlock: end }),
      ]);
      const matches = [...inbound, ...outbound];
      const blockNumbers = [...new Set(matches.map((l) => l.blockNumber))];
      const blocks = new Map((await Promise.all(blockNumbers.map((n) => provider.getBlock(n)))).map((b) => [b.number, b]));
      for (const log of matches) {
        const parsed = iface.parseLog(log);
        const direction = parsed.args.to.toLowerCase() === TREASURY ? "in" : "out";
        const counterparty = direction === "in" ? parsed.args.from : parsed.args.to;
        const [category, source] = direction === "in" ? sourceLabel(counterparty) : ["Operational", "Treasury outbound"];
        entries.push({
          tx: log.transactionHash, block: log.blockNumber, timestamp: Number(blocks.get(log.blockNumber)?.timestamp || 0),
          // Transfer.value on this precompile is emitted in the logical
          // 6-decimal USDC convention even though balanceOf() mirrors the
          // native 18-decimal balance -- confirmed live (raw 15000 -> 0.015
          // USDC at 6dec, not 1.5e-14 at 18dec). Using 18 here summed 491
          // real transfers down to ~7e-12 total.
          direction, token: "USDC", amount: Number(formatUnits(parsed.args.value, 6)),
          from: parsed.args.from, to: parsed.args.to, category, source,
        });
      }
      // Checkpoint every chunk so a slow/interrupted first run resumes near
      // where it left off instead of re-scanning from GENESIS_FLOOR.
      writeFileSync(STATE, JSON.stringify({ lastBlock: end, entries: entries.slice(0, 1000) }, null, 2));
      console.log(`scanned ${start}-${end} (tip ${tip}), ${matches.length} matches this chunk, ${entries.length} total`);
    }
  }

  entries.sort((a, b) => b.block - a.block);
  const kept = entries.slice(0, 1000);
  writeFileSync(STATE, JSON.stringify({ lastBlock: tip, entries: kept }, null, 2));

  const [native, usdcBal] = await Promise.all([provider.getBalance(TREASURY), new Contract(USDC, erc20, provider).balanceOf(TREASURY)]);
  const totals = {
    inUsd: kept.filter((x) => x.direction === "in").reduce((s, x) => s + x.amount, 0),
    outUsd: kept.filter((x) => x.direction === "out").reduce((s, x) => s + x.amount, 0),
    revenueUsd: kept.filter((x) => x.category === "Revenue").reduce((s, x) => s + x.amount, 0),
    unknownUsd: kept.filter((x) => x.category === "Unknown").reduce((s, x) => s + x.amount, 0),
  };
  const payload = {
    version: 1, chainId: 5042, treasury: TREASURY, indexedAt: new Date().toISOString(), indexedBlock: tip,
    // Same precompile decimal split as Transfer.value above: balanceOf()
    // reports the logical 6-decimal USDC amount, native getBalance() reports
    // the 18-decimal wei-style amount -- both equal 7.33195 for the same
    // real balance, confirmed live; they are NOT both 18-decimal.
    balances: { nativeUsdc: Number(formatUnits(native, 18)), usdcErc20: Number(formatUnits(usdcBal, 6)) },
    totals,
    counts: { transactions: kept.length, inbound: kept.filter((x) => x.direction === "in").length, outbound: kept.filter((x) => x.direction === "out").length, attributed: kept.filter((x) => x.category !== "Unknown").length },
    entries: kept,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(`Mainnet treasury stats written: ${OUT} (${kept.length} transfers, scanned to block ${tip})`);
  await provider.destroy();
}

main().catch((e) => { console.error(e); process.exit(1); });

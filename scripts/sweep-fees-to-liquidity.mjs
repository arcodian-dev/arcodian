// Protocol-owned liquidity: sweep accrued launchpad fees into the FX pool.
//
// Three fee streams reach the treasury today. Bridge (150 bps) and swap (30 bps)
// arrive directly as Circle/LI.FI custom fees. Launchpad curve fees (100 bps)
// accrue inside each curve contract and must be pulled with
// withdrawProtocolFees(), which is TREASURY_ONLY.
//
// Every deployed curve hardcodes its treasury address immutably, so this cannot
// be replaced by an on-chain router for existing markets — a new contract would
// only affect markets created after it. Hence a script.
//
// Default is a DRY RUN that reports balances and does nothing. Pass --execute to
// actually sweep and add liquidity.
//
//   node scripts/sweep-fees-to-liquidity.mjs              # report only
//   node scripts/sweep-fees-to-liquidity.mjs --execute    # sweep + add liquidity
//
// Requires TREASURY_PK in the environment when executing. The treasury is an EOA
// the operator controls; this script never prints the key.

import { Contract, JsonRpcProvider, Wallet, formatUnits } from "ethers";

const RPC = process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network/";
const TREASURY = "0xF1CBe360b45F2E22Ab74A2c434e5602f66105CaF";
const USDC = "0x3600000000000000000000000000000000000000";
const EURC = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";
const FX_POOL = "0x982D61ddCAb6169d82B3e37A4E4158f1982E5447";
const MARKET_INDEX = process.env.MARKET_INDEX || "https://arcodian.fun/data/market-index.json";

// Share of swept fees converted into protocol-owned liquidity. The remainder
// stays liquid in the treasury for gas, infra and audits.
const LIQUIDITY_SHARE_BPS = Number(process.env.LIQUIDITY_SHARE_BPS || 5000); // 50%

const execute = process.argv.includes("--execute");

const CURVE_ABI = [
  "function accruedProtocolFees() view returns (uint256)",
  "function withdrawProtocolFees()",
  "function QUOTE_KIND() view returns (uint8)",
];

// Fees do not accrue in one denomination. The V7 (USDC) engine pays out native
// USDC at 18 decimals via call{value:}; the EURC engine transfers EURC at 6
// decimals. Treating both as 6-dec overstates the USDC side by 10^12 — the same
// decimal trap the FX spec warns about. Curves are classified by probing
// QUOTE_KIND(), which only the EURC engine exposes.
const NATIVE_TO_UNIT_6 = 10n ** 12n;
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];
const POOL_ABI = [
  "function addLiquidity(uint256,uint256,uint256,uint64) returns (uint256)",
  "function reserveUsdc() view returns (uint256)",
  "function reserveEurc() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

const usd = (v) => `${Number(formatUnits(v, 6)).toFixed(6)}`;

async function main() {
  const provider = new JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });

  // 1. Find every curve and read what it has accrued.
  const index = await fetch(MARKET_INDEX, { cache: "no-store" }).then((r) => r.json());
  const curves = (index.launches || []).map((l) => l.curve).filter(Boolean);
  console.log(`Scanning ${curves.length} curves for accrued fees…`);

  const accrued = [];
  let accruedUsdc6 = 0n; // native-USDC curves, normalized to 6 decimals
  let accruedEurc6 = 0n; // EURC curves, already 6 decimals
  for (const address of curves) {
    try {
      const curve = new Contract(address, CURVE_ABI, provider);
      const amount = await curve.accruedProtocolFees();
      if (amount === 0n) continue;
      let isEurc = false;
      try {
        isEurc = Number(await curve.QUOTE_KIND()) === 1;
      } catch {
        isEurc = false; // no QUOTE_KIND getter => V7 native-USDC engine
      }
      const asUnits6 = isEurc ? amount : amount / NATIVE_TO_UNIT_6;
      accrued.push({ address, amount, isEurc, asUnits6 });
      if (isEurc) accruedEurc6 += asUnits6;
      else accruedUsdc6 += asUnits6;
    } catch {
      // Not every venue exposes the vault (graduated DEX pairs differ); skip.
    }
  }

  const usdcToken = new Contract(USDC, ERC20_ABI, provider);
  const eurcToken = new Contract(EURC, ERC20_ABI, provider);
  const [treasuryUsdc, treasuryEurc] = await Promise.all([
    usdcToken.balanceOf(TREASURY),
    eurcToken.balanceOf(TREASURY),
  ]);

  const pool = new Contract(FX_POOL, POOL_ABI, provider);
  const [reserveUsdc, reserveEurc, poolShares] = await Promise.all([
    pool.reserveUsdc(),
    pool.reserveEurc(),
    pool.balanceOf(TREASURY),
  ]);

  console.log("");
  console.log(`Curves with fees   : ${accrued.length}`);
  console.log(`Unswept (USDC)     : ${usd(accruedUsdc6)}`);
  console.log(`Unswept (EURC)     : ${usd(accruedEurc6)}`);
  console.log(`Treasury USDC      : ${usd(treasuryUsdc)}`);
  console.log(`Treasury EURC      : ${usd(treasuryEurc)}`);
  console.log(`Pool reserves      : ${usd(reserveUsdc)} USDC / ${usd(reserveEurc)} EURC`);
  console.log(`Treasury LP shares : ${poolShares}`);
  console.log("");

  // 2. Decide how much becomes liquidity. Both sides count what is already in
  // the treasury plus what this run would sweep out of the curves.
  const availableUsdc = treasuryUsdc + accruedUsdc6;
  const availableEurc = treasuryEurc + accruedEurc6;
  const budgetUsdc = (availableUsdc * BigInt(LIQUIDITY_SHARE_BPS)) / 10_000n;
  const budgetEurc = (availableEurc * BigInt(LIQUIDITY_SHARE_BPS)) / 10_000n;

  // Liquidity must go in at the pool's current ratio, so the smaller side caps
  // the deposit. EURC is usually the constraint: only the EURC engine produces
  // EURC fees, and it sees less volume than the USDC engine.
  const eurcNeeded = reserveUsdc > 0n ? (budgetUsdc * reserveEurc) / reserveUsdc : 0n;
  const eurcBudget = eurcNeeded < budgetEurc ? eurcNeeded : budgetEurc;
  const usdcBudget = reserveEurc > 0n ? (eurcBudget * reserveUsdc) / reserveEurc : 0n;

  console.log(`Liquidity share    : ${LIQUIDITY_SHARE_BPS / 100}%`);
  console.log(`Would add          : ${usd(usdcBudget)} USDC + ${usd(eurcBudget)} EURC`);

  if (eurcBudget < eurcNeeded) {
    console.log("");
    console.log(`NOTE: EURC is the limiting side. ${usd(budgetEurc)} EURC is available but`);
    console.log(`      ${usd(eurcNeeded)} is needed to pair the USDC budget at the pool ratio,`);
    console.log(`      so only ${usd(usdcBudget)} USDC can be deployed. Acquire EURC (FX widget`);
    console.log("      or faucet) to put the rest of the USDC budget to work.");
  }

  if (!execute) {
    console.log("");
    console.log("Dry run — nothing sent. Re-run with --execute to sweep and add liquidity.");
    return;
  }

  if (usdcBudget <= 0n || eurcBudget <= 0n) {
    console.log("");
    console.log("Nothing to add: one side of the pair is zero. Aborting without sending.");
    return;
  }

  const pk = process.env.TREASURY_PK;
  if (!pk) throw new Error("TREASURY_PK is required to execute.");
  const signer = new Wallet(pk, provider);
  if ((await signer.getAddress()).toLowerCase() !== TREASURY.toLowerCase()) {
    throw new Error("TREASURY_PK does not match the treasury address.");
  }

  // 3. Pull accrued fees out of each curve.
  for (const { address, asUnits6, isEurc } of accrued) {
    process.stdout.write(`  withdrawing ${usd(asUnits6)} ${isEurc ? "EURC" : "USDC"} from ${address}… `);
    const curve = new Contract(address, CURVE_ABI, signer);
    await (await curve.withdrawProtocolFees()).wait();
    console.log("ok");
  }

  // 4. Add liquidity.
  for (const [token, amount, label] of [
    [USDC, usdcBudget, "USDC"],
    [EURC, eurcBudget, "EURC"],
  ]) {
    const erc20 = new Contract(token, ERC20_ABI, signer);
    if ((await erc20.allowance(TREASURY, FX_POOL)) < amount) {
      process.stdout.write(`  approving ${label}… `);
      await (await erc20.approve(FX_POOL, amount)).wait();
      console.log("ok");
    }
  }

  const deadline = Math.floor(Date.now() / 1000) + 600;
  process.stdout.write("  adding liquidity… ");
  const tx = await new Contract(FX_POOL, POOL_ABI, signer)
    .addLiquidity(usdcBudget, eurcBudget, 1, deadline);
  await tx.wait();
  console.log("ok");

  const after = await pool.balanceOf(TREASURY);
  console.log("");
  console.log(`Treasury LP shares : ${poolShares} -> ${after}`);
  console.log(`tx: ${tx.hash}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

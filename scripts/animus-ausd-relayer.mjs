// Animus Synthetic AUSD relayer.
//
// This service integrates with the existing IntentSettler deployments. It does
// not mint AUSD directly and it does not pretend that a source-chain deposit
// exists. A source adapter must first authenticate the deposit and hand this
// process a source reference. The relayer then quotes a 1.5% treasury fee and
// can build or broadcast a type-2 deposit intent only when its signer has the
// protocol's required role.

import { readFile } from "node:fs/promises";
import { AbiCoder, Contract, JsonRpcProvider, Wallet, formatUnits, keccak256, parseUnits, toUtf8Bytes } from "ethers";

const ARC_SETTLER = "0x03a13352ef67977d1601ec1276e9bc27c0ee7b75";
const BASE_SETTLER = "0xF2993f19dAc23a2Df38a07f90cCA74f983B16dEc";
const ARC_AUSD = "0xf5b08979251f398180385b54381ee3d6fa1bbe09";
const BASE_AUSD = "0x42867eeBf208E4fB8Ad01146832E3d47A8b7757b";
const ARC_PERMISSION_MANAGER = "0xE3A2649829e430aB778E262600D3ac3B0e75DAeF";
const BASE_PERMISSION_MANAGER = "0x36Dcd86AC9Bf04a44bb3414dE7b2EDcef0A03050";
const TREASURY = "0xF1CBe360b45F2E22Ab74A2c434e5602f66105CaF";
const REPORTER_ROLE = keccak256(toUtf8Bytes("REPORTER"));
const MINT_SOLVER_ROLE = keccak256(toUtf8Bytes("MINT_SOLVER"));
const FEE_BPS = 150n;
const BPS = 10_000n;

const SETTLER_ABI = [
  "function open((uint8 intentType,address tokenIn,uint256 amountIn,address tokenOut,uint256 amountOut,address recipient,uint32 fillDeadline,bytes orderData) intent) returns(bytes32)",
  "function openModes(uint8) view returns(uint8)",
  "function resolveModes(uint8) view returns(uint8)",
  "function permissionManager() view returns(address)",
  "function mintLimits(address,address) view returns(uint256,uint256,uint256,uint48)",
];
const PERMISSION_ABI = ["function hasRole(bytes32,address) view returns(bool)"];

function fail(message) {
  throw new Error(message);
}

function loadConfig() {
  const path = process.env.ANIMUS_RELAYER_CONFIG || "/root/.config/arcodian/animus-ausd-relayer.json";
  return readFile(path, "utf8").then(JSON.parse).then((config) => ({ config, path }));
}

function feeQuote(gross) {
  if (gross <= 0n) fail("gross amount must be positive");
  const fee = gross * FEE_BPS / BPS;
  const net = gross - fee;
  if (fee === 0n || net === 0n) fail("amount is too small for a 1.5% fee");
  return { gross, fee, net };
}

function printQuote(quote) {
  console.log(JSON.stringify({
    token: "Animus AUSD",
    decimals: 18,
    feeBps: Number(FEE_BPS),
    feePercent: "1.50%",
    gross: quote.gross.toString(),
    fee: quote.fee.toString(),
    net: quote.net.toString(),
    grossAUSD: formatUnits(quote.gross, 18),
    feeAUSD: formatUnits(quote.fee, 18),
    netAUSD: formatUnits(quote.net, 18),
    treasury: TREASURY,
  }, null, 2));
}

async function providers(config) {
  const arcRpc = config.arcRpc || "https://warp-arc-production.up.railway.app/rpc";
  const baseRpc = config.baseRpc || "https://mainnet.base.org";
  return {
    arc: new JsonRpcProvider(arcRpc, 5042, { staticNetwork: true, batchMaxCount: 1 }),
    base: new JsonRpcProvider(baseRpc, 8453, { staticNetwork: true, batchMaxCount: 1 }),
  };
}

async function inspect(config) {
  const { arc, base } = await providers(config);
  try {
    const signer = config.reporterPrivateKey ? new Wallet(config.reporterPrivateKey) : null;
    const signerAddress = signer?.address || null;
    const rows = [];
    for (const [network, provider, settlerAddress, permissionManager, token] of [
      ["arc", arc, ARC_SETTLER, ARC_PERMISSION_MANAGER, ARC_AUSD],
      ["base", base, BASE_SETTLER, BASE_PERMISSION_MANAGER, BASE_AUSD],
    ]) {
      const settler = new Contract(settlerAddress, SETTLER_ABI, provider);
      const pm = new Contract(permissionManager, PERMISSION_ABI, provider);
      const [openMode, resolveMode, settlerPm, tip] = await Promise.all([
        settler.openModes(2),
        settler.resolveModes(2),
        settler.permissionManager(),
        provider.getBlockNumber(),
      ]);
      const hasReporter = signerAddress ? await pm.hasRole(REPORTER_ROLE, signerAddress) : false;
      const hasMintSolver = signerAddress ? await pm.hasRole(MINT_SOLVER_ROLE, signerAddress) : false;
      const limit = signerAddress ? await settler.mintLimits(signerAddress, token) : null;
      rows.push({ network, tip, settler: settlerAddress, permissionManager: settlerPm, type2: { openMode: Number(openMode), resolveMode: Number(resolveMode) }, signer: signerAddress, reporterRole: hasReporter, mintSolverRole: hasMintSolver, mintLimit: limit ? { maxPerWindow: limit[0].toString(), windowSize: Number(limit[1]), usedInWindow: limit[2].toString() } : null });
    }
    console.log(JSON.stringify({ treasury: TREASURY, feeBps: Number(FEE_BPS), rows }, null, 2));
  } finally {
    arc.destroy();
    base.destroy();
  }
}

function buildOrderData({ nonce, depositRef, sourceTxHash, sourceChain }) {
  if (!/^0x[a-fA-F0-9]{64}$/.test(depositRef) || !/^0x[a-fA-F0-9]{64}$/.test(sourceTxHash)) fail("depositRef and sourceTxHash must be bytes32 hex values");
  return AbiCoder.defaultAbiCoder().encode(["uint256", "bytes32", "bytes32", "string"], [nonce, depositRef, sourceTxHash, sourceChain]);
}

async function dryRunOpen(config, args) {
  const { arc } = await providers(config);
  try {
    const signer = config.reporterPrivateKey ? new Wallet(config.reporterPrivateKey, arc) : null;
    if (!signer) fail("reporterPrivateKey is required for an open dry-run");
    const pm = new Contract(ARC_PERMISSION_MANAGER, PERMISSION_ABI, arc);
    if (!(await pm.hasRole(REPORTER_ROLE, signer.address))) fail(`configured signer ${signer.address} does not hold REPORTER role on Arc`);
    const settlerRead = new Contract(ARC_SETTLER, SETTLER_ABI, arc);
    const resolveMode = Number(await settlerRead.resolveModes(2));
    if (resolveMode === 2 && !(await pm.hasRole(MINT_SOLVER_ROLE, signer.address))) {
      fail(`configured signer ${signer.address} lacks MINT_SOLVER role required by Arc type-2 DEPOSIT; opening alone would leave the intent unsettled`);
    }
    const quote = feeQuote(parseUnits(args.gross, 18));
    const orderData = buildOrderData({ nonce: BigInt(args.nonce), depositRef: args.depositRef, sourceTxHash: args.sourceTxHash, sourceChain: args.sourceChain });
    const intent = { intentType: 2, tokenIn: "0x0000000000000000000000000000000000000000", amountIn: 0n, tokenOut: ARC_AUSD, amountOut: quote.net, recipient: args.recipient, fillDeadline: Math.floor(Date.now() / 1000) + 1800, orderData };
    const contract = new Contract(ARC_SETTLER, SETTLER_ABI, signer);
    const tx = await contract.open.populateTransaction(intent);
    const gas = await arc.estimateGas({ from: signer.address, to: ARC_SETTLER, data: tx.data });
    printQuote(quote);
    console.log(JSON.stringify({ mode: "dry-run", signer: signer.address, recipient: args.recipient, orderData, gas: gas.toString(), broadcast: false }, null, 2));
  } finally {
    arc.destroy();
  }
}

async function main() {
  const command = process.argv[2] || "inspect";
  if (command === "quote") {
    printQuote(feeQuote(parseUnits(process.argv[3] || "0", 18)));
    return;
  }
  const { config, path } = await loadConfig().catch((error) => fail(`cannot load ${process.env.ANIMUS_RELAYER_CONFIG || "/root/.config/arcodian/animus-ausd-relayer.json"}: ${error.message}`));
  if (command === "inspect") {
    await inspect(config);
    return;
  }
  if (command === "dry-run-open") {
    const args = { gross: process.argv[3], recipient: process.argv[4], sourceChain: process.argv[5], sourceTxHash: process.argv[6], depositRef: process.argv[7], nonce: process.argv[8] || String(Date.now()) };
    if (!args.gross || !/^0x[a-fA-F0-9]{40}$/.test(args.recipient) || !args.sourceChain || !args.sourceTxHash || !args.depositRef) fail("usage: dry-run-open <grossAUSD> <recipient> <sourceChain> <sourceTxHash bytes32> <depositRef bytes32> [nonce]");
    await dryRunOpen(config, args);
    return;
  }
  fail(`unknown command ${command}; config=${path}`);
}

main().catch((error) => { console.error(error.message || error); process.exitCode = 1; });

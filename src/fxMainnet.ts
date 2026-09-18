import { AbiCoder, Contract, Interface, JsonRpcProvider, Network } from "ethers";
import { ARC_MAINNET, ARC_MAINNET_CONTRACTS } from "./config";

/// Stablecoin FX on Arc Mainnet: Arcodian's own USDC/EURC pool plus the
/// external Uniswap V3 USDC/EURC pools, reached through Arcodian's swap fee
/// router. Every quote is exact — the external ones by simulating the real
/// pool swap (see contracts/src/quoting/ArcodianV3Probe.sol).

export const FX_USDC = ARC_MAINNET_CONTRACTS.usdc;
export const FX_EURC = ARC_MAINNET_CONTRACTS.eurc;
export const FX_POOL = ARC_MAINNET_CONTRACTS.fxPool;
export const FX_FEE_ROUTER = ARC_MAINNET_CONTRACTS.externalV3FeeRouter;
const EXTERNAL_V3_FACTORY = ARC_MAINNET_CONTRACTS.externalV3Factory;
const V3_FEE_TIERS = [100, 500, 3000, 10000] as const;

/** Runtime code of ArcodianV3Probe, placed at PROBE_ADDRESS only inside eth_call. */
const PROBE_CODE = "0x608060405234801561000f575f80fd5b5060043610610034575f3560e01c8063343afba514610038578063fa461e331461005d575b5f80fd5b61004b6100463660046101f6565b610072565b60405190815260200160405180910390f35b61007061006b366004610243565b6101d3565b005b5f836001600160a01b031663128acb08308585876100a45773fffd8963efd1fc6a506488495d951d5263988d256100ab565b6401000276a45b60405160e086901b6001600160e01b03191681526001600160a01b03948516600482015292151560248401526044830191909152909116606482015260a060848201525f60a482015260c40160408051808303815f875af1925050508015610130575060408051601f3d908101601f1916820190925261012d918101906102bc565b60015b610190573d80801561015d576040519150601f19603f3d011682016040523d82523d5f602084013e610162565b606091505b50805160201461017457805160208201fd5b8080602001905181019061018891906102de565b9150506101cc565b505060405162461bcd60e51b815260206004820152600b60248201526a4e4f5f43414c4c4241434b60a81b604482015260640160405180910390fd5b9392505050565b5f8085126101e157836101e3565b845b6101ec906102f5565b9050805f5260205ffd5b5f805f60608486031215610208575f80fd5b83356001600160a01b038116811461021e575f80fd5b925060208401358015158114610232575f80fd5b929592945050506040919091013590565b5f805f8060608587031215610256575f80fd5b8435935060208501359250604085013567ffffffffffffffff8082111561027b575f80fd5b818701915087601f83011261028e575f80fd5b81358181111561029c575f80fd5b8860208285010111156102ad575f80fd5b95989497505060200194505050565b5f80604083850312156102cd575f80fd5b505080516020909101519092909150565b5f602082840312156102ee575f80fd5b5051919050565b5f600160ff1b820161031557634e487b7160e01b5f52601160045260245ffd5b505f039056fea2646970667358221220f7159d16fb990b71717d5b5f466d3b9f172474eee3a7fe7c671d60cd641787dd64736f6c63430008180033";
const PROBE_ADDRESS = "0x00000000000000000000000000000000A2C0d1a9";
const probe = new Interface(["function quote(address pool, bool zeroForOne, uint256 amountIn) returns (uint256)"]);

export const FX_POOL_ABI = [
  "function quote(bool usdcToEurc, uint256 amountIn) view returns (uint256)",
  "function swap(bool usdcToEurc, uint256 amountIn, uint256 minOut, uint64 deadline) returns (uint256)",
  "function reserveUsdc() view returns (uint256)",
  "function reserveEurc() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function addLiquidity(uint256 usdcAmount, uint256 eurcAmount, uint256 minShares, uint64 deadline) returns (uint256)",
  "function removeLiquidity(uint256 shares, uint256 minUsdc, uint256 minEurc, uint64 deadline) returns (uint256, uint256)",
];
export const FX_FEE_ROUTER_ABI = [
  "function quote(uint256 grossAmount) pure returns (uint256 protocolFee, uint256 netAmount)",
  "function swapExactInputSingle(address tokenIn, address tokenOut, uint24 poolFee, uint256 grossAmountIn, uint256 amountOutMinimum, uint256 deadline) returns (uint256)",
];
export const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

/** One provider for reads: eth_call with a state override needs raw JSON-RPC. */
export const fxRead = new JsonRpcProvider(ARC_MAINNET.rpc, Network.from(ARC_MAINNET.id), { staticNetwork: Network.from(ARC_MAINNET.id), batchMaxCount: 1 });

export type FxRoute =
  | { venue: "arcodian"; label: string; amountOut: bigint; spender: string; feeLabel: string }
  | { venue: "external"; label: string; amountOut: bigint; spender: string; feeLabel: string; poolFee: number; pool: string };

async function probeQuote(pool: string, zeroForOne: boolean, amountIn: bigint): Promise<bigint> {
  const data = probe.encodeFunctionData("quote", [pool, zeroForOne, amountIn]);
  const result = await fxRead.send("eth_call", [{ to: PROBE_ADDRESS, data }, "latest", { [PROBE_ADDRESS]: { code: PROBE_CODE } }]);
  return AbiCoder.defaultAbiCoder().decode(["uint256"], result)[0] as bigint;
}

/** Every executable route for this trade, best first. */
export async function fxRoutes(usdcToEurc: boolean, amountIn: bigint): Promise<FxRoute[]> {
  if (amountIn <= 0n) return [];
  const tokenIn = usdcToEurc ? FX_USDC : FX_EURC;
  const tokenOut = usdcToEurc ? FX_EURC : FX_USDC;
  const routes: FxRoute[] = [];

  const pool = new Contract(FX_POOL, FX_POOL_ABI, fxRead);
  const [reserveUsdc, reserveEurc] = await Promise.all([pool.reserveUsdc(), pool.reserveEurc()]).catch(() => [0n, 0n]);
  if (reserveUsdc > 0n && reserveEurc > 0n) {
    const out = await pool.quote(usdcToEurc, amountIn).catch(() => 0n) as bigint;
    if (out > 0n) routes.push({ venue: "arcodian", label: "Arcodian FX pool", amountOut: out, spender: FX_POOL, feeLabel: "0.10% (0.08% to liquidity providers)" });
  }

  const factory = new Contract(EXTERNAL_V3_FACTORY, ["function getPool(address,address,uint24) view returns (address)"], fxRead);
  const router = new Contract(FX_FEE_ROUTER, FX_FEE_ROUTER_ABI, fxRead);
  const [, net] = await router.quote(amountIn) as [bigint, bigint];
  const zeroForOne = BigInt(tokenIn) < BigInt(tokenOut);
  for (const fee of V3_FEE_TIERS) {
    const address = await factory.getPool(tokenIn, tokenOut, fee).catch(() => "0x0000000000000000000000000000000000000000") as string;
    if (/^0x0{40}$/i.test(address)) continue;
    const out = await probeQuote(address, zeroForOne, net).catch(() => 0n);
    if (out > 0n) routes.push({ venue: "external", label: `Uniswap V3 · ${fee / 10_000}% pool`, amountOut: out, spender: FX_FEE_ROUTER, feeLabel: `0.30% Arcodian + ${fee / 10_000}% pool`, poolFee: fee, pool: address });
  }
  return routes.sort((a, b) => (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0));
}

/** External liquidity the desk can route to, in USDC-equivalent units (6 dp). */
export async function externalFxDepth(): Promise<{ usdc: bigint; eurc: bigint }> {
  const factory = new Contract(EXTERNAL_V3_FACTORY, ["function getPool(address,address,uint24) view returns (address)"], fxRead);
  const usdc = new Contract(FX_USDC, ERC20_ABI, fxRead), eurc = new Contract(FX_EURC, ERC20_ABI, fxRead);
  let u = 0n, e = 0n;
  for (const fee of V3_FEE_TIERS) {
    const address = await factory.getPool(FX_USDC, FX_EURC, fee).catch(() => "") as string;
    if (!address || /^0x0{40}$/i.test(address)) continue;
    const [bu, be] = await Promise.all([usdc.balanceOf(address), eurc.balanceOf(address)]).catch(() => [0n, 0n]);
    u += bu; e += be;
  }
  return { usdc: u, eurc: e };
}

import { ARC_MAINNET_CONTRACTS } from "./config";

export type LendMarket = { id:string; name:string; borrowAsset:"USDC"; collateralSymbol:string; collateralAddress:string; collateralDecimals:number; marketAddress:string; maxLtv:number; liquidationThreshold:number; status:"live"|"planned"; note:string };

// One isolated contract and oracle per collateral. Never add an asset based on
// ticker alone: verify its canonical contract, decimals, liquidity, and oracle.
export const LEND_MARKETS: readonly LendMarket[] = [{
  id:"eurc-usdc", name:"EURC / USDC", borrowAsset:"USDC", collateralSymbol:"EURC",
  collateralAddress:ARC_MAINNET_CONTRACTS.eurc, collateralDecimals:6,
  marketAddress:ARC_MAINNET_CONTRACTS.arcLendMarket, maxLtv:70, liquidationThreshold:80, status:"live",
  note:"Circle's EURC on Arc Mainnet.",
}] as const;

export const OFFICIAL_ARC_ASSET_STATUS = [
  { symbol:"USDC", state:"Borrow + supply", note:"Native Arc gas and debt asset" },
  { symbol:"EURC", state:"Live collateral", note:"Circle's EURC · isolated market" },
  { symbol:"USYC", state:"Not enabled", note:"Permissioned institutional asset; eligibility and oracle required" },
  { symbol:"ETH / WETH", state:"Awaiting canonical asset", note:"No official Arc Mainnet contract published" },
  { symbol:"BTC / WBTC", state:"Awaiting canonical asset", note:"No official Arc Mainnet contract published" },
] as const;

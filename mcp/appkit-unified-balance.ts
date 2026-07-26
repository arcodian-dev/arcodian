import { AppKit } from "@circle-fin/app-kit";
import { Contract, getAddress } from "ethers";
import { AGENT_PASSPORT_ABI, AGENT_PASSPORT_ADDRESS } from "./tools/_config.ts";

type BalanceKit = {
  unifiedBalance: {
    getSupportedChains(token?: "USDC"): Array<{ chain: string; isTestnet: boolean }>;
    getBalances(params: Record<string, unknown>): Promise<any>;
  };
};

const kit: BalanceKit = new AppKit({ disableErrorReporting: true }) as unknown as BalanceKit;

export async function inspectUnifiedBalance(
  input: { agentId: string; chains?: string[]; includePending?: boolean },
  ctx: any,
  appKit: BalanceKit = kit,
) {
  const passport = new Contract(AGENT_PASSPORT_ADDRESS, AGENT_PASSPORT_ABI, ctx.provider());
  const wallet = getAddress(await passport.walletOf(BigInt(input.agentId)));
  if (wallet === "0x0000000000000000000000000000000000000000") {
    throw new Error("agent has no active Passport wallet");
  }

  const supported = new Set(
    appKit.unifiedBalance.getSupportedChains("USDC")
      .filter((chain) => chain.isTestnet)
      .map((chain) => chain.chain),
  );
  const chains = input.chains?.length ? [...new Set(input.chains)] : ["Arc_Testnet"];
  if (chains.length > 16) throw new Error("too many chains");
  for (const chain of chains) {
    if (!supported.has(chain)) throw new Error(`unsupported USDC testnet chain: ${chain}`);
  }

  const balance = await appKit.unifiedBalance.getBalances({
    token: "USDC",
    sources: { address: wallet, chains },
    includePending: input.includePending ?? true,
    networkType: "testnet",
  });
  const depositor = balance.breakdown?.[0]?.depositor;
  if (depositor && getAddress(depositor) !== wallet) throw new Error("Gateway returned another depositor");

  return {
    agentId: input.agentId,
    passportWallet: wallet,
    networkType: "testnet",
    requestedChains: chains,
    ...balance,
    source: "Circle App Kit Unified Balance",
    readOnly: true,
  };
}

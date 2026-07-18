export type MainnetReadinessInput = {
  enabled: boolean;
  chainId: number;
  rpcUrl: string;
  explorerUrl: string;
  usdcAddress: string;
  deployer: string;
  treasury: string;
  treasuryMultisig: boolean;
  auditSignedOff: boolean;
  canarySignedOff: boolean;
};

const addressPattern = /^0x[a-fA-F0-9]{40}$/;
const httpsUrl = (value: string) => {
  try { return new URL(value).protocol === "https:"; } catch { return false; }
};

export function mainnetReadiness(input: MainnetReadinessInput) {
  const checks = [
    { key: "feature", label: "Release flag", ok: input.enabled },
    { key: "chain", label: "Arc mainnet chain 5042", ok: input.chainId === 5042 },
    { key: "rpc", label: "Official HTTPS RPC", ok: httpsUrl(input.rpcUrl) },
    { key: "explorer", label: "Official HTTPS explorer", ok: httpsUrl(input.explorerUrl) },
    { key: "usdc", label: "Official USDC address", ok: addressPattern.test(input.usdcAddress) },
    { key: "deployer", label: "Authorized deployer", ok: addressPattern.test(input.deployer) },
    { key: "treasury", label: "Treasury address", ok: addressPattern.test(input.treasury) },
    { key: "multisig", label: "Treasury multisig verified", ok: input.treasuryMultisig },
    { key: "audit", label: "Independent audit sign-off", ok: input.auditSignedOff },
    { key: "canary", label: "Canary sign-off", ok: input.canarySignedOff },
  ];
  return { checks, ready: checks.every((check) => check.ok) };
}

import { describe, expect, it } from "vitest";
import { getAddress } from "ethers";
import {
  ARC,
  CHAINS,
  CCTP_MAINNET_MESSAGE_TRANSMITTER_V2,
  CCTP_MAINNET_TOKEN_MESSENGER_V2,
  MAINNET_CHAINS,
  TOKENS,
} from "./config";

describe("official Arc Testnet configuration", () => {
  it("uses the official chain and RPC", () => {
    expect(ARC.id).toBe(5042002);
    expect(ARC.hexId).toBe("0x4cef52");
    // Browser reads go through the same-origin proxy (api/rpc.php), which rotates
    // across the public Arc RPCs server-side to avoid per-browser 429 rate limits.
    expect(ARC.rpc).toBe("https://arcodian.fun/api/rpc.php");
    expect(ARC.rpcs).toContain("https://arcodian.fun/api/rpc.php");
    expect(ARC.nativeDecimals).toBe(18);
    expect(ARC.erc20Decimals).toBe(6);
  });

  it("uses official stablecoin contracts", () => {
    expect(TOKENS[0].address).toBe("0x3600000000000000000000000000000000000000");
    expect(TOKENS[1].address).toBe("0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a");
  });

  it("keeps Arc Testnet available to bridge and swap flows", () => {
    expect(CHAINS.some((chain) => chain.id === ARC.id && chain.appKit === "Arc_Testnet")).toBe(true);
    expect(TOKENS.every((token) => token.decimals === 6)).toBe(true);
  });
});

describe("mainnet bridge addresses", () => {
  it("uses addresses accepted by ethers checksum validation", () => {
    const addresses = [
      ...MAINNET_CHAINS.map((chain) => chain.token),
      CCTP_MAINNET_TOKEN_MESSENGER_V2,
      CCTP_MAINNET_MESSAGE_TRANSMITTER_V2,
    ];

    for (const address of addresses) {
      expect(() => getAddress(address)).not.toThrow();
    }
  });
});

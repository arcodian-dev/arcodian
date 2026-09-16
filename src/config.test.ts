import { describe, expect, it } from "vitest";
import { getAddress } from "ethers";
import {
  ARC,
  ARC_EURC_ADDRESS,
  ARC_MAINNET,
  ARC_MAINNET_CONTRACTS,
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

describe("official Circle contracts on Arc Mainnet (published 2026-09-16)", () => {
  // Every address here was verified against chain 5042 with eth_getCode on
  // the day Circle published them, and EURC additionally by reading its own
  // name()/symbol()/decimals(). These are Circle's published values, so a
  // diff in this test means either a typo or Circle moving a contract —
  // both worth failing the build over, since the bridge and balance reads
  // send real money at them.
  it("pins Circle's Arc Mainnet EURC, distinct from the testnet contract", () => {
    expect(ARC_MAINNET_CONTRACTS.eurc).toBe("0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1");
    // The two networks' EURC are different contracts. Reusing one address
    // for both would read a token that does not exist on the other chain.
    expect(ARC_MAINNET_CONTRACTS.eurc.toLowerCase()).not.toBe(ARC_EURC_ADDRESS.toLowerCase());
    expect(getAddress(ARC_MAINNET_CONTRACTS.eurc)).toBe(ARC_MAINNET_CONTRACTS.eurc);
  });

  it("pins the rest of Circle's published Arc Mainnet registry", () => {
    expect(ARC_MAINNET_CONTRACTS.usyc).toBe("0x8a5D989Bbb96929F689B0200f435f53dA42bF490");
    expect(ARC_MAINNET_CONTRACTS.usycEntitlements).toBe("0xb69ecb156Dc0028198028c501340d5367845ca72");
    expect(ARC_MAINNET_CONTRACTS.usycTeller).toBe("0x51A8CE47dC08ba5CD19c7aa84EA6fD6664f60f9b");
    expect(ARC_MAINNET_CONTRACTS.gatewayWallet).toBe("0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE");
    expect(ARC_MAINNET_CONTRACTS.gatewayMinter).toBe("0x2222222d7164433c4C09B0b0D809a9b52C04C205");
    expect(ARC_MAINNET_CONTRACTS.stableFxEscrow).toBe("0xe2E5F173576B513d994073CCbDaCBE027d43DFe6");
    expect(ARC_MAINNET_CONTRACTS.cctpTokenMinterV2).toBe("0xfd78EE919681417d192449715b2594ab58f5D002");
    expect(ARC_MAINNET_CONTRACTS.cctpMessageV2).toBe("0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78");
    expect(ARC_MAINNET_CONTRACTS.memo).toBe("0x5294E9927c3306DcBaDb03fe70b92e01cCede505");
    expect(ARC_MAINNET_CONTRACTS.multicall3From).toBe("0x522fAf9A91c41c443c66765030741e4AaCe147D0");
  });

  it("leads with Circle's own RPC and keeps the log-capable endpoint next", () => {
    // rpc.mainnet.arc.io refuses many-address eth_getLogs filters outright;
    // blockdaemon is the only official endpoint that serves them, so it has
    // to sit immediately behind the default rather than at the back of the
    // list. See the measured limits recorded in config.ts.
    expect(ARC_MAINNET.rpc).toBe("https://rpc.mainnet.arc.io");
    expect(ARC_MAINNET.rpcs[0]).toBe("https://rpc.mainnet.arc.io");
    expect(ARC_MAINNET.rpcs[1]).toBe("https://rpc.blockdaemon.mainnet.arc.io");
    // Arcscan stays reachable as a fallback — it was degraded on launch day,
    // not wrong.
    expect(ARC_MAINNET.rpcs).toContain("https://rpc.arc-scan.org/");
  });

  it("does not point public explorer links at Circle's SSO-gated explorer", () => {
    // explorer.arc.io 302s to circle.cloudflareaccess.com; linking a user
    // there sends them to a login wall instead of their transaction.
    expect(ARC_MAINNET.explorer).not.toContain("explorer.arc.io");
  });
});

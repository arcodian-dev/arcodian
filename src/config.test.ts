import { describe, expect, it } from "vitest";
import { getAddress } from "ethers";
import {
  ARC,
  ARC_EURC_ADDRESS,
  ARC_MAINNET,
  ARC_MAINNET_CONTRACTS,
  ACTIVE_LAUNCH_FACTORY,
  ACTIVE_ENGINE_VERSION,
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

  it("leads with the endpoints that do not rate-limit a busy page", () => {
    // Circle's own rpc.mainnet.arc.io and QuickNode's each rejected over
    // half of 60 eth_calls fired in ~1.5s with "rate limit exceeded" —
    // roughly what one bridge or portfolio page does across its reads, and
    // it surfaces to a user as a read that never resolves. Blockdaemon and
    // drpc served 60/60. Blockdaemon leads because it ALSO is the only
    // official endpoint that serves many-address eth_getLogs. See the
    // measured numbers recorded in config.ts.
    expect(ARC_MAINNET.rpc).toBe("https://rpc.blockdaemon.mainnet.arc.io");
    expect(ARC_MAINNET.rpcs[0]).toBe("https://rpc.blockdaemon.mainnet.arc.io");
    expect(ARC_MAINNET.rpcs[1]).toBe("https://rpc.drpc.mainnet.arc.io");
    expect(ARC_MAINNET.rpcs).toContain("https://rpc.mainnet.arc.io");
    // Arcscan stays reachable as a fallback — it was degraded on launch day,
    // not wrong.
    expect(ARC_MAINNET.rpcs).toContain("https://rpc.arc-scan.org/");
  });

  it("pins Arcodian's own EURC contracts, deployed on launch day", () => {
    // Verified on-chain after deploy by reading each contract's immutables
    // back. The FX pool is deliberately recorded while still unseeded — the
    // address is real, the liquidity is not.
    expect(ARC_MAINNET_CONTRACTS.fxPool).toBe("0x506f61b6c287c616bb7ef827d2455b401373418f");
    expect(ARC_MAINNET_CONTRACTS.eurcPumpFactoryV11).toBe("0x426e68f06207a3f3ef7aa261f3856e71746af7aa");
  });

  it("pins the V12 engine and the V4 contracts it trades on", () => {
    expect(ARC_MAINNET_CONTRACTS.launchFactoryV12).toBe("0x95b4d7CCbd0D13aF4ba2CCd1Dd037C30B9eD76C2");
    // V4 reads a hook's permissions from the low bits of its own address.
    // beforeSwap (1<<7) + beforeSwapReturnDelta (1<<3) = 0x0088; a hook at
    // any other address is simply never called, so this is load-bearing.
    expect(ARC_MAINNET_CONTRACTS.launchHookV12).toBe("0xe05D566f070Ac8508C3a4f4C15AA02dE100ec088");
    expect(BigInt(ARC_MAINNET_CONTRACTS.launchHookV12) & 0x3fffn).toBe(0x0088n);
    expect(ARC_MAINNET_CONTRACTS.v4PoolManager).toBe("0x8366a39CC670B4001A1121B8F6A443A643e40951");
    expect(ARC_MAINNET_CONTRACTS.v4PositionManager).toBe("0x6049c9a0e26405c0985f9e3685c87d0ae917f82b");
  });

  it("never routes Create to the V12 factory, which prices a launch at zero", () => {
    expect(ACTIVE_LAUNCH_FACTORY).not.toBe(ARC_MAINNET_CONTRACTS.launchFactoryV12);
  });

  it("launches on V13 with a hook whose address carries its permissions", () => {
    expect(ACTIVE_LAUNCH_FACTORY).toBe("0xDFE3e7C6e139860d88f13FCCB6A1d9dCEE2211e2");
    expect(ACTIVE_ENGINE_VERSION).toBe(15);
    expect(BigInt(ARC_MAINNET_CONTRACTS.launchHookV15) & 0x3fffn).toBe(0x20ccn);
    expect(BigInt(ARC_MAINNET_CONTRACTS.launchHookV14) & 0x3fffn).toBe(0x20ccn);
    expect(BigInt(ARC_MAINNET_CONTRACTS.launchHookV13) & 0x3fffn).toBe(0x0088n);
    expect(ARC_MAINNET_CONTRACTS.v4Router).toBe("0xb865dB1cC95b05Ee939b74779C6996173da8fb48");
  });

  it("points public explorer links at Circle's official mainnet explorer", () => {
    // explorer.arc.io was SSO-gated at launch and opened to the public on
    // 2026-09-17; the mainnet UI must never link the testnet explorer.
    expect(ARC_MAINNET.explorer).toBe("https://explorer.arc.io");
    expect(ARC_MAINNET.explorer).not.toContain("testnet");
  });
});

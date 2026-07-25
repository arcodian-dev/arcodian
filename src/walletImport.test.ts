import { describe, expect, it } from "vitest";
import { Mnemonic, Wallet, randomBytes } from "ethers";
import { walletFromRecoveryInput } from "./walletImport";

describe("wallet recovery input", () => {
  it("imports a 12-word phrase", () => {
    const wallet = Wallet.createRandom();
    expect(walletFromRecoveryInput(wallet.mnemonic!.phrase).address).toBe(wallet.address);
  });

  it("imports a 24-word phrase", () => {
    const phrase = Mnemonic.fromEntropy(randomBytes(32)).phrase;
    expect(phrase.split(" ")).toHaveLength(24);
    expect(walletFromRecoveryInput(phrase).address).toMatch(/^0x[0-9A-Fa-f]{40}$/);
  });

  it("imports a private key with or without 0x", () => {
    const wallet = Wallet.createRandom();
    expect(walletFromRecoveryInput(wallet.privateKey).address).toBe(wallet.address);
    expect(walletFromRecoveryInput(wallet.privateKey.slice(2)).address).toBe(wallet.address);
  });

  it("rejects malformed recovery input", () => {
    expect(() => walletFromRecoveryInput("not a wallet secret")).toThrow();
  });
});

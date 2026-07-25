import { Wallet } from "ethers";

export function walletFromRecoveryInput(raw: string) {
  const value = raw.trim();
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length === 12 || words.length === 24) return Wallet.fromPhrase(words.join(" "));
  const privateKey = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("Expected 12/24 words or a 32-byte private key");
  return new Wallet(privateKey);
}

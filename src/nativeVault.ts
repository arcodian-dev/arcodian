import { Capacitor, registerPlugin } from "@capacitor/core";

type VaultPlugin = {
  save(options: { secret: string }): Promise<void>;
  load(): Promise<{ secret: string | null }>;
  clear(): Promise<void>;
  authenticate(options: { reason: string }): Promise<{ authenticated: boolean }>;
  biometricStatus(): Promise<{ available: boolean }>;
};

const SecureVault = registerPlugin<VaultPlugin>("SecureVault");

export const isNativeWallet = () => Capacitor.isNativePlatform();
export async function saveWalletSecret(secret: string) {
  if (!isNativeWallet()) throw new Error("Local wallet vault is available only in the Android application");
  await SecureVault.save({ secret });
}
export async function loadWalletSecret() {
  if (!isNativeWallet()) return null;
  return (await SecureVault.load()).secret;
}
export async function clearWalletSecret() {
  if (isNativeWallet()) await SecureVault.clear();
}
export async function authenticateWallet(reason = "Unlock Arcodian Wallet") {
  if (!isNativeWallet()) return true;
  return (await SecureVault.authenticate({ reason })).authenticated;
}
export async function biometricAvailable() {
  if (!isNativeWallet()) return false;
  return (await SecureVault.biometricStatus()).available;
}

/// <reference types="vite/client" />

interface EthereumProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
  isMetaMask?: boolean;
  isOkxWallet?: boolean;
  isOKExWallet?: boolean;
  isBitKeep?: boolean;
  isBitgetWallet?: boolean;
  isRabby?: boolean;
  isCoinbaseWallet?: boolean;
  isZerion?: boolean;
}

interface EIP6963ProviderInfo { uuid: string; name: string; icon: string; rdns: string }
interface EIP6963ProviderDetail { info: EIP6963ProviderInfo; provider: EthereumProvider }
interface Window { ethereum?: EthereumProvider }

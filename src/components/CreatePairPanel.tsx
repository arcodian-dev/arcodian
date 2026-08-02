import { useMemo, useState } from "react";
import { BrowserProvider, Contract } from "ethers";
import { ARC, ARC_MAINNET, ARC_MAINNET_CONTRACTS, ARC_PAIR_FACTORY_ADDRESS } from "../config";
import { arcProvider } from "../shared";
import { FACTORY_ABI, type TokenMeta } from "../dexReads";
import { TokenField } from "./TokenField";
import type { Tier } from "../dex";

export default function CreatePairPanel({ account, activeProvider, onConnect, chainId }: {
  account: string;
  activeProvider: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } | null;
  onConnect: () => void;
  chainId?: number | null;
}) {
  const isMainnet = chainId == null || chainId === ARC_MAINNET.id;
  const activeArc = isMainnet ? ARC_MAINNET : ARC;
  const activeFactory = isMainnet ? ARC_MAINNET_CONTRACTS.marketPairFactory : ARC_PAIR_FACTORY_ADDRESS;
  const read = useMemo(() => arcProvider(activeArc), [activeArc]);
  const [tokenA, setTokenA] = useState<TokenMeta | null>(null);
  const [tokenB, setTokenB] = useState<TokenMeta | null>(null);
  const [tier, setTier] = useState<Tier>(30);
  const [acknowledged, setAcknowledged] = useState(false);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!account || !activeProvider) { onConnect(); return; }
    if (!tokenA || !tokenB) { setStatus("Enter both token addresses."); return; }
    setBusy(true);
    setStatus("");
    try {
      await activeProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: activeArc.hexId }] });
      const signer = await new BrowserProvider(activeProvider as never).getSigner();
      const factory = new Contract(activeFactory, FACTORY_ABI, signer);
      setStatus("Creating pool…");
      const tx = await factory.createPair(tokenA.address, tokenB.address, tier);
      await tx.wait();
      const created = (await new Contract(activeFactory, FACTORY_ABI, read)
        .getPair(tokenA.address, tokenB.address, tier)) as string;
      setStatus(`Pool created at ${created}. Add liquidity from the Pools tab — the first deposit sets the price.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message.slice(0, 140) : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dex-panel">
      <TokenField label="Token A" runner={read} value={tokenA} onChange={setTokenA} />
      <TokenField label="Token B" runner={read} value={tokenB} onChange={setTokenB} />

      <div className="dex-tiers">
        <label>Fee tier</label>
        <div>
          <button type="button" className={tier === 10 ? "active" : ""} onClick={() => setTier(10)}>
            0.10% · stablecoin pairs
          </button>
          <button type="button" className={tier === 30 ? "active" : ""} onClick={() => setTier(30)}>
            0.30% · everything else
          </button>
        </div>
        <small>The tier is permanent for this pool and cannot be changed later.</small>
      </div>

      <label className="dex-ack">
        <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
        <span>
          I understand the first deposit sets this pool's starting price. If it does
          not match the real market rate, the difference is taken by the first
          arbitrage trade — and it is taken from me.
        </span>
      </label>

      <button type="button" className="dex-cta" disabled={busy || !acknowledged || !tokenA || !tokenB} onClick={create}>
        {busy ? "Working…" : !account ? "Connect wallet" : "Create pool"}
      </button>
      {status && <p className="dex-status">{status}</p>}
    </div>
  );
}

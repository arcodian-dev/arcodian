import { useEffect, useState } from "react";
import type { ContractRunner } from "ethers";
import { isCircleAsset, isTokenAddress, shortAddress } from "../dex";
import { readToken, type TokenMeta } from "../dexReads";

/**
 * Token entry by contract address. The symbol is read from the chain and is
 * always rendered beside the address — never alone. Anyone can deploy a token
 * called "USDC", so the address is the only identity that means anything.
 */
export function TokenField({ label, runner, value, onChange }: {
  label: string;
  runner: ContractRunner;
  value: TokenMeta | null;
  onChange: (token: TokenMeta | null) => void;
}) {
  const [input, setInput] = useState(value?.address ?? "");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const address = input.trim();
    if (!address) { setError(""); onChange(null); return; }
    if (!isTokenAddress(address)) { setError("Not a contract address."); onChange(null); return; }

    let alive = true;
    setLoading(true);
    setError("");
    readToken(runner, address)
      .then((meta) => { if (alive) onChange(meta); })
      .catch(() => { if (alive) { setError("No ERC-20 found at this address."); onChange(null); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // onChange is intentionally excluded: callers pass inline closures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, runner]);

  return (
    <div className="token-field">
      <label>{label}</label>
      <input
        spellCheck={false}
        placeholder="Paste token contract address (0x…)"
        value={input}
        onChange={(event) => setInput(event.target.value)}
      />
      {loading && <small className="token-hint">Reading token…</small>}
      {error && <small className="token-error">{error}</small>}
      {value && (
        <div className="token-identity">
          <b>{value.symbol}</b>
          <span className="token-address">{shortAddress(value.address)}</span>
          {isCircleAsset(value.address) && <em className="token-circle">Circle-issued</em>}
          <small>{value.name}</small>
        </div>
      )}
      <p className="token-warning">
        Anyone can name a token anything. The contract address is the only identity
        that matters — check it against a source you trust.
      </p>
    </div>
  );
}

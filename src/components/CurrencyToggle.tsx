import type { Currency } from "../fx";

const STORAGE_KEY = "arcodian.displayCurrency";

export function loadDisplayCurrency(): Currency {
  if (typeof window === "undefined") return "USDC";
  return window.localStorage.getItem(STORAGE_KEY) === "EURC" ? "EURC" : "USDC";
}

export function saveDisplayCurrency(currency: Currency): void {
  if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, currency);
}

export function CurrencyToggle({ value, onChange }: { value: Currency; onChange: (c: Currency) => void }) {
  return (
    <div className="currency-toggle" role="group" aria-label="Display currency">
      {(["USDC", "EURC"] as Currency[]).map((c) => (
        <button
          key={c}
          type="button"
          className={value === c ? "active" : ""}
          aria-pressed={value === c}
          onClick={() => { saveDisplayCurrency(c); onChange(c); }}
        >
          {c === "USDC" ? "$ USDC" : "€ EURC"}
        </button>
      ))}
    </div>
  );
}

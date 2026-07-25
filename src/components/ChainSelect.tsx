import { useEffect, useRef, useState } from "react";

type Option = { id: number; name: string };
type Props = {
  value: number;
  options: Option[];
  onChange: (id: number) => void;
  ariaLabel?: string;
  disabled?: boolean;
};

// A native <select> is unreliable inside embedded wallet browsers (OKX, MetaMask
// in-app), where the dropdown often refuses to open. This is a plain button +
// popover that behaves identically everywhere, is keyboard accessible, and closes
// on outside-click or Escape.
export default function ChainSelect({ value, options, onChange, ariaLabel, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.id === value);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent | TouchEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("touchstart", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("touchstart", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="chain-select" ref={root}>
      <button
        type="button"
        className="chain-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
      >
        <span>{current?.name || "Select network"}</span>
        <i aria-hidden="true" className={open ? "open" : ""}>▾</i>
      </button>
      {open && (
        <ul className="chain-select-menu" role="listbox">
          {options.map((o) => (
            <li key={o.id} role="option" aria-selected={o.id === value}>
              <button
                type="button"
                className={o.id === value ? "active" : ""}
                onClick={() => { onChange(o.id); setOpen(false); }}
              >
                {o.name}
                {o.id === value && <em aria-hidden="true">✓</em>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

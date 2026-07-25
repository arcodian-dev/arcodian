import { useEffect } from "react";
import "./ProductLanding.css";

type Product = "wallet";

const COPY = {
  wallet: {
    label: "ARCODIAN WALLET",
    title: "Your money, payments, and onchain credit—one wallet.",
    body: "A full self-custody wallet for Arc. Hold and move stablecoins, scan Arc Pay invoices, swap, supply, borrow, and monitor activity from one application.",
    primary: "Download Android Wallet",
    href: "https://arcodian.fun/downloads/arcodian-wallet-testnet-v0.5.3-debug.apk",
    points: [
      "Self-custody by design",
      "Native USDC on Arc",
      "Pay and Earn built in",
    ],
  },
} satisfies Record<
  Product,
  {
    label: string;
    title: string;
    body: string;
    primary: string;
    href: string;
    points: string[];
  }
>;

export default function ProductLanding({ product }: { product: Product }) {
  const copy = COPY[product];
  useEffect(() => {
    document.title = `${copy.label} — Arcodian`;
  }, [copy.label]);
  return (
    <main className={`product-site product-${product}`}>
      <nav>
        <a className="product-brand" href="https://arcodian.fun">
          <img src="/arcodian-mark.svg" alt="" />
          <span>
            ARCODIAN<small>{copy.label}</small>
          </span>
        </a>
        <div>
          <a href="https://arcodian.fun">Ecosystem</a>
          <a href="https://wallet.arcodian.fun/app">Web Demo</a>
          <a href="https://arcodian.fun/arcpay">Arc Pay</a>
          <a href="https://lend.arcodian.fun/">Lend</a>
          <a className="product-nav-cta" href={copy.href}>
            {copy.primary}
          </a>
        </div>
      </nav>
      <section className="product-hero">
        <div className="product-copy">
          <p>{copy.label} · ARC TESTNET</p>
          <h1>{copy.title}</h1>
          <span>{copy.body}</span>
          <div className="product-actions">
            <a className="product-secondary" href="https://wallet.arcodian.fun/app">Open Web Demo</a>
            <a className="product-primary" href={copy.href}>
              {copy.primary}
            </a>
          </div>
          <ul>
            {copy.points.map((point) => (
              <li key={point}>✓ {point}</li>
            ))}
          </ul>
          <small className="product-platform-note">
            Android only · Arc network only · Keys remain encrypted on device
          </small>
        </div>
        <div className="product-visual">
          <div className="product-orbit" />
          <img src="/arcodian-mark.svg" alt="Arcodian" />
          <div className="product-card">
            <small>TOTAL PORTFOLIO</small>
            <strong>$8,746.82</strong>
            <span>USDC · EURC · Arc Testnet</span>
          </div>
        </div>
      </section>
      <section className="product-flow">
        <p>ARC PAY · BUILT IN</p>
        <h2>Payments live inside Arcodian Wallet.</h2>
        <div className="product-pay-flow">
          <article>
            <b>01</b>
            <h3>Create checkout</h3>
            <span>
              Merchant sets the exact USDC amount, order memo, and invoice
              expiry inside Arcodian Wallet.
            </span>
          </article>
          <article>
            <b>02</b>
            <h3>Display or share QR</h3>
            <span>
              Arc Pay creates a contract-bound request for an in-person
              checkout or remote order.
            </span>
          </article>
          <article>
            <b>03</b>
            <h3>Scan and review</h3>
            <span>
              Buyer scans the QR and verifies merchant, exact amount, Arc
              network, expiry, and fee before signing.
            </span>
          </article>
          <article>
            <b>04</b>
            <h3>Confirm and settle</h3>
            <span>
              Merchant receives 99.70% directly while settlement is reconciled
              on Arc.
            </span>
          </article>
        </div>
        <aside className="product-pay-proof">
          <span>Exact amount</span><span>One-use invoice</span><span>Expiry validation</span><span>Replay protection</span><span>Optional payer binding</span><span>Memo reconciliation</span>
        </aside>
      </section>
      <section className="product-capabilities">
        <p>ONE APP · FULL ARC EXPERIENCE</p>
        <h2>More than a balance screen.</h2>
        <span>
          Arcodian Wallet is purpose-built for Arc—not a generic multichain
          skin.
        </span>
        <div>
          {[
            {
              icon: "✦",
              title: "Create or import",
              text: "Create a fresh 12-word EVM wallet, or import an existing 12/24-word phrase or private key.",
            },
            {
              icon: "↗",
              title: "Send & receive",
              text: "Move native USDC on Arc, share your address, and generate local payment requests.",
            },
            {
              icon: "⌗",
              title: "Arc Pay",
              text: "Create, scan, review, and settle exact invoices with expiry and replay protection.",
            },
            {
              icon: "⇄",
              title: "Swap routes",
              text: "Access Arcodian's USDC and EURC routes without leaving your wallet experience.",
            },
            {
              icon: "◇",
              title: "Earn & borrow",
              text: "Supply USDC and manage isolated lending positions with visible health and collateral rules.",
            },
            {
              icon: "◎",
              title: "Activity & security",
              text: "Follow wallet actions and control the encrypted wallet stored on this Android device.",
            },
          ].map((feature) => (
            <article key={feature.title}>
              <i>{feature.icon}</i>
              <h3>{feature.title}</h3>
              <span>{feature.text}</span>
            </article>
          ))}
        </div>
      </section>
      <section className="product-security">
        <div>
          <p>YOUR KEYS · YOUR DEVICE</p>
          <h2>Designed around self-custody.</h2>
          <span>
            Recovery material is never uploaded to Arcodian. The active private
            key is encrypted with AES-GCM using a non-exportable Android
            Keystore key, and Android app backups are disabled.
          </span>
          <ul>
            <li>Android Keystore encryption</li>
            <li>No browser wallet storage</li>
            <li>No Arcodian recovery server</li>
            <li>Arc Testnet locked for this release</li>
          </ul>
        </div>
        <aside>
          <small>SECURITY STATUS</small>
          <strong>DEVICE PROTECTED</strong>
          <span>Encrypted locally · backups disabled</span>
          <b>ARC ONLY</b>
        </aside>
      </section>
      <section className="product-responsive">
        <p>ADAPTS TO YOUR DEVICE</p>
        <h2>Phone, foldable, or tablet.</h2>
        <span>
          The interface automatically responds to screen width, height,
          orientation, display cutouts, Android navigation areas, and the
          on-screen keyboard.
        </span>
        <div>
          <b>Compact phone</b>
          <b>Tall phone</b>
          <b>Landscape</b>
          <b>Foldable</b>
          <b>Tablet</b>
        </div>
      </section>
      <footer>
        <span>ARCODIAN · ARC TESTNET</span>
        <a href={copy.href}>{copy.primary} →</a>
      </footer>
    </main>
  );
}

import { useEffect, useMemo, useState } from "react";
import { BrowserProvider, Contract, formatEther } from "ethers";
import { ARC, ARC_PAY_ADDRESS } from "../config";
import { describeTxError } from "../txError";
import "./ArcPayLanding.css";

const APK_URL = "/downloads/arcodian-wallet-testnet-v0.5.3-debug.apk";

const FLOW = [
  { n: "01", title: "Create checkout", text: "Merchant enters the exact native-USDC amount, order memo, optional payer, and invoice expiry." },
  { n: "02", title: "Show or share QR", text: "Arc Pay creates a contract-bound request for a counter checkout, invoice screen, or remote order." },
  { n: "03", title: "Scan and verify", text: "The buyer scans with Arcodian Wallet and reviews merchant, amount, Arc network, expiry, and fee." },
  { n: "04", title: "Confirm payment", text: "The buyer signs locally. No private key, recovery phrase, or approval is sent to Arcodian servers." },
  { n: "05", title: "Settle and reconcile", text: "99.70% reaches the merchant, 0.30% is recorded for treasury, and the event links back to the order memo." },
] as const;

type PaymentRow = { invoiceId: string; merchant: string; payer: string; gross: string; merchantNet: string; fee: string; grossUsd: number; refunded: boolean; timestamp: number; tx: string };
type Props = { account: string; activeProvider: EthereumProvider | null; connect: () => void };
const ARC_PAY_ABI = [
  "function payments(bytes32) view returns(address payer,address merchant,uint128 amount,uint128 fee,uint64 paidAt,bool refunded)",
  "function refund(bytes32) payable",
];

export default function ArcPayLanding({ account, activeProvider, connect }: Props) {
  const [stats, setStats] = useState<null | {
    indexedAt: string;
    totals: { payments: number; merchants: number; grossVolumeUsd: number; merchantNetUsd: number; protocolFeesUsd: number; refunds: number; successfulInvoices: number };
    recent: PaymentRow[];
  }>(null);
  const [workspaceOnly, setWorkspaceOnly] = useState(false);
  const [selected, setSelected] = useState<PaymentRow | null>(null);
  const [refundBusy, setRefundBusy] = useState("");
  const [workspaceStatus, setWorkspaceStatus] = useState("");
  useEffect(() => {
    document.title = "Arc Pay — QR checkout on Arc | Arcodian";
    let alive = true;
    const load = () => fetch(`/data/arcpay-stats.json?t=${Date.now()}`, { cache: "no-store" }).then((response) => response.ok ? response.json() : Promise.reject()).then((value) => { if (alive) setStats(value); }).catch(() => undefined);
    void load(); const timer = window.setInterval(() => void load(), 60_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);
  const money = (value: number) => `${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`;
  const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
  const merchantRows = useMemo(() => stats?.recent.filter((payment) => !workspaceOnly || (account && payment.merchant.toLowerCase() === account.toLowerCase())) || [], [stats, workspaceOnly, account]);
  const merchantTotals = useMemo(() => merchantRows.reduce((sum, row) => { const today = row.timestamp >= Math.floor(Date.now() / 1000) - 86_400; return { payments: sum.payments + 1, gross: sum.gross + Number(row.grossUsd || 0), net: sum.net + Number(formatEther(BigInt(row.merchantNet || "0"))), fees: sum.fees + Number(formatEther(BigInt(row.fee || "0"))), refunds: sum.refunds + (row.refunded ? 1 : 0), dailyPayments: sum.dailyPayments + (today ? 1 : 0), dailyVolume: sum.dailyVolume + (today ? Number(row.grossUsd || 0) : 0) }; }, { payments: 0, gross: 0, net: 0, fees: 0, refunds: 0, dailyPayments: 0, dailyVolume: 0 }), [merchantRows]);

  function exportCsv() {
    const header = ["status","invoice_id","payer","merchant","gross_usdc","net_usdc","fee_usdc","timestamp","transaction"];
    const lines = merchantRows.map((row) => [row.refunded ? "Refunded" : "Paid", row.invoiceId, row.payer, row.merchant, row.grossUsd, formatEther(BigInt(row.merchantNet || "0")), formatEther(BigInt(row.fee || "0")), new Date(row.timestamp * 1000).toISOString(), row.tx].map((cell) => `"${String(cell).replaceAll('"','""')}"`).join(","));
    const url = URL.createObjectURL(new Blob([[header.join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `arc-pay-${account ? short(account).replace("…", "-") : "all"}.csv`; anchor.click(); URL.revokeObjectURL(url);
  }

  async function refund(payment: PaymentRow) {
    if (!account || !activeProvider) { connect(); return; }
    setRefundBusy(payment.invoiceId); setWorkspaceStatus("Verifying merchant ownership and payment status onchain…");
    try {
      await activeProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ARC.hexId }] });
      const provider = new BrowserProvider(activeProvider as never);
      const reader = new Contract(ARC_PAY_ADDRESS, ARC_PAY_ABI, provider);
      const state = await reader.payments(payment.invoiceId) as { payer: string; merchant: string; amount: bigint; refunded: boolean };
      if (state.merchant.toLowerCase() !== account.toLowerCase()) throw new Error("Only the merchant that received this invoice can refund it.");
      if (state.refunded) throw new Error("This payment has already been refunded.");
      if (state.payer.toLowerCase() !== payment.payer.toLowerCase() || state.amount !== BigInt(payment.gross)) throw new Error("Indexed receipt does not match contract state.");
      setWorkspaceStatus(`Confirm full refund of ${formatEther(state.amount)} USDC in your wallet.`);
      const signer = await provider.getSigner();
      const tx = await new Contract(ARC_PAY_ADDRESS, ARC_PAY_ABI, signer).refund(payment.invoiceId, { value: state.amount });
      setWorkspaceStatus(`Refund submitted ${short(tx.hash)}. Waiting for confirmation…`);
      await tx.wait();
      setWorkspaceStatus(`Refund confirmed ${short(tx.hash)}. Dashboard will refresh after indexing.`);
    } catch (error) { setWorkspaceStatus(describeTxError(error)); }
    finally { setRefundBusy(""); }
  }

  return (
    <main className="arc-pay-site">
      <section className="arc-pay-hero">
        <div>
          <p>ARC PAY · BUILT INTO ARCODIAN WALLET</p>
          <h1>One QR.<br />One exact payment.</h1>
          <span>Turn an order into a verifiable native-USDC checkout. Merchants create and display the invoice; customers scan, review, and confirm it inside Arcodian Wallet.</span>
          <div className="arc-pay-actions">
            <a href={APK_URL} download>Download Android Wallet</a>
            <a href="#how-it-works">See how it works</a>
          </div>
          <ul><li>Arc Testnet</li><li>Native USDC</li><li>0.30% merchant fee</li><li>Non-custodial</li></ul>
        </div>
        <aside aria-label="Arc Pay checkout preview">
          <header><span>ARC PAY CHECKOUT</span><b>● READY</b></header>
          <div className="arc-pay-qr" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /><i /><i /></div>
          <small>ORDER #AC-2048</small>
          <strong>24.00 USDC</strong>
          <span>Arc Testnet · expires in 09:42</span>
          <button type="button" disabled>Scan with Arcodian Wallet</button>
        </aside>
      </section>

      <section className="arc-pay-role-grid">
        <article><p>FOR MERCHANTS</p><h2>Checkout without ambiguity.</h2><span>Create an exact-amount invoice, attach a memo or order ID, show the QR at checkout, and reconcile payment from the emitted settlement event.</span></article>
        <article><p>FOR CUSTOMERS</p><h2>Scan, review, approve.</h2><span>Scan the merchant QR inside Arcodian Wallet, verify every payment field, and sign only after the destination, amount, network, and expiry are clear.</span></article>
      </section>

      <section id="how-it-works" className="arc-pay-flow">
        <p>END-TO-END FLOW</p><h2>From order to onchain receipt.</h2>
        <div>{FLOW.map((step) => <article key={step.n}><b>{step.n}</b><h3>{step.title}</h3><span>{step.text}</span></article>)}</div>
      </section>

      <section className="arc-pay-controls">
        <div><p>PAYMENT INTEGRITY</p><h2>Invoice rules enforced by the contract.</h2><span>Arc Pay is more than an address QR. The request is bound to the deployed settlement contract and validated before the Wallet enables confirmation.</span></div>
        <ul>
          <li><b>Exact amount</b><span>The payment must match the invoice amount.</span></li>
          <li><b>One-use invoice ID</b><span>A settled invoice cannot be replayed.</span></li>
          <li><b>Expiry validation</b><span>Expired requests fail closed.</span></li>
          <li><b>Optional payer binding</b><span>A merchant may restrict who can settle.</span></li>
          <li><b>Memo hash</b><span>Orders can be reconciled without storing the memo onchain.</span></li>
          <li><b>Merchant refund path</b><span>A full refund can be executed once by the merchant.</span></li>
        </ul>
      </section>

      <section className="arc-pay-economics">
        <p>TRANSPARENT ECONOMICS</p><h2>Simple fee. Direct settlement.</h2>
        <div><article><small>BUYER</small><strong>0%</strong><span>Arc Pay protocol fee; network gas still applies.</span></article><article><small>MERCHANT RECEIVES</small><strong>99.70%</strong><span>Transferred directly during settlement.</span></article><article><small>PROTOCOL FEE</small><strong>0.30%</strong><span>Accrued in the contract fee vault for treasury withdrawal.</span></article></div>
      </section>

      <section className="arc-pay-dashboard" aria-label="Live Arc Pay merchant dashboard">
        <div className="arc-pay-dashboard-head"><div><p>MERCHANT OPERATIONS · ONCHAIN</p><h2>Settlement dashboard.</h2><span>Finalized Arc Pay events only. Connect the merchant wallet to reconcile, export, and refund its invoices.</span></div><b>● {stats ? "LIVE" : "SYNCING"}</b></div>
        <div className="arc-pay-workspace-bar">
          <div><strong>{workspaceOnly && account ? `Merchant ${short(account)}` : "Public network overview"}</strong><small>{workspaceOnly ? "Only invoices settled to the connected merchant" : "All finalized Arc Pay settlements"}</small></div>
          {!account ? <button onClick={connect}>Connect merchant wallet</button> : <><button className={workspaceOnly ? "active" : ""} onClick={() => setWorkspaceOnly((value) => !value)}>{workspaceOnly ? "Show network" : "My workspace"}</button><button disabled={!merchantRows.length} onClick={exportCsv}>Export CSV</button></>}
        </div>
        <div className="arc-pay-dashboard-metrics">
          <article><small>Gross payment volume</small><strong>{stats ? money(workspaceOnly ? merchantTotals.gross : stats.totals.grossVolumeUsd) : "—"}</strong></article>
          <article><small>Paid invoices</small><strong>{stats ? workspaceOnly ? merchantTotals.payments : stats.totals.payments : "—"}</strong></article>
          <article><small>{workspaceOnly ? "Net received" : "Active merchants"}</small><strong>{stats ? workspaceOnly ? money(merchantTotals.net) : stats.totals.merchants : "—"}</strong></article>
          <article><small>{workspaceOnly ? "Fees paid" : "Merchant settlement"}</small><strong>{stats ? money(workspaceOnly ? merchantTotals.fees : stats.totals.merchantNetUsd) : "—"}</strong></article>
          <article><small>Refunded payments</small><strong>{stats ? workspaceOnly ? merchantTotals.refunds : stats.totals.refunds : "—"}</strong></article>
          <article><small>{workspaceOnly ? "24h sales" : "Protocol revenue"}</small><strong>{stats ? workspaceOnly ? `${merchantTotals.dailyPayments} · ${money(merchantTotals.dailyVolume)}` : money(stats.totals.protocolFeesUsd) : "—"}</strong></article>
        </div>
        <div className="arc-pay-settlements">
          <header><span>Recent settlements</span><small>{stats ? `Updated ${new Date(stats.indexedAt).toLocaleString()}` : "Reading Arc Testnet…"}</small></header>
          <div className="arc-pay-settlement-row arc-pay-settlement-labels"><span>Status</span><span>Merchant</span><span>Amount</span><span>Invoice</span><span>Transaction</span></div>
          {merchantRows.length ? merchantRows.slice(0, 25).map((payment) => <button className="arc-pay-settlement-row" key={payment.tx} onClick={() => setSelected(payment)}>
            <span className={payment.refunded ? "refunded" : "paid"}>{payment.refunded ? "REFUNDED" : "PAID"}</span><code>{short(payment.merchant)}</code><strong>{money(payment.grossUsd)}</strong><code>{short(payment.invoiceId)}</code><span>{short(payment.tx)} →</span>
          </button>) : <p className="arc-pay-no-settlements">{workspaceOnly ? "No finalized invoice belongs to this merchant wallet yet." : "No finalized Arc Pay settlement has been indexed yet."}</p>}
        </div>
        {workspaceStatus && <p className="arc-pay-workspace-status">{workspaceStatus}</p>}
        {selected && <div className="arc-pay-receipt-modal" onMouseDown={() => setSelected(null)}><article onMouseDown={(event) => event.stopPropagation()}><button className="arc-pay-receipt-close" onClick={() => setSelected(null)}>×</button><p>ARC PAY RECEIPT</p><h3>{money(selected.grossUsd)}</h3><span className={selected.refunded ? "refunded" : "paid"}>{selected.refunded ? "REFUNDED" : "PAID"}</span><dl><div><dt>Invoice</dt><dd>{selected.invoiceId}</dd></div><div><dt>Payer</dt><dd>{selected.payer}</dd></div><div><dt>Merchant</dt><dd>{selected.merchant}</dd></div><div><dt>Merchant net</dt><dd>{formatEther(BigInt(selected.merchantNet || "0"))} USDC</dd></div><div><dt>Protocol fee</dt><dd>{formatEther(BigInt(selected.fee || "0"))} USDC</dd></div><div><dt>Settled</dt><dd>{new Date(selected.timestamp * 1000).toLocaleString()}</dd></div></dl><div className="arc-pay-receipt-actions"><a href={`${ARC.explorer}/tx/${selected.tx}`} target="_blank" rel="noreferrer">View on Arcscan ↗</a><button onClick={() => window.print()}>Print receipt</button>{account && selected.merchant.toLowerCase() === account.toLowerCase() && !selected.refunded && <button className="refund" disabled={refundBusy === selected.invoiceId} onClick={() => void refund(selected)}>{refundBusy ? "Refunding…" : "Refund full amount"}</button>}</div></article></div>}
      </section>

      <section className="arc-pay-boundary">
        <div><p>CURRENT SCOPE</p><h2>Arc Pay is onchain USDC checkout—not independent QRIS.</h2><span>Arc Pay QR is live for Arc Testnet invoices inside Arcodian Wallet. Production QRIS or automatic IDR merchant settlement will require integration with a licensed Indonesian PJP/acquirer or off-ramp partner.</span></div>
        <a href={APK_URL} download>Try Arc Pay in Wallet →</a>
      </section>
    </main>
  );
}

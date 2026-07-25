import { useEffect, useMemo, useState } from "react";
import {
  BrowserProvider,
  Contract,
  JsonRpcProvider,
  Wallet as EthersWallet,
  ZeroAddress,
  ZeroHash,
  formatEther,
  formatUnits,
  hexlify,
  id,
  parseUnits,
  randomBytes,
  zeroPadValue,
} from "ethers";
import QRCode from "qrcode";
import {
  BarcodeFormat,
  BarcodeScanner,
} from "@capacitor-mlkit/barcode-scanning";
import {
  ARC,
  ARC_LEND_ADDRESS,
  ARC_LEND_COLLATERAL_ADDRESS,
  ARC_PAY_ADDRESS,
  CHAINS,
} from "../config";
import {
  CCTP_DOMAIN,
  MESSAGE_TRANSMITTER_V2,
  MESSAGE_TRANSMITTER_ABI,
  fetchCctpAttestation,
  fetchCctpFee,
  clearPendingClaim,
  recordBridgeHistory,
  savePendingClaim,
} from "../bridgeRecovery";
import {
  arcPayFee,
  arcPayUri,
  normalizeRecipient,
  parseArcNativeAmount,
  parseArcPayUri,
  recipientFingerprint,
  recipientSafety,
  type WalletContact,
} from "../walletCore";
import {
  authenticateWallet,
  biometricAvailable,
  clearWalletSecret,
  isNativeWallet,
  loadWalletSecret,
  saveWalletSecret,
} from "../nativeVault";
import { DEFAULT_AUTO_LOCK_MS, mergeWalletNotices, parseWalletDeepLink, shouldAutoLock, systemAlertsToWalletNotices, type SystemAlert, type WalletNotice } from "../walletRc";
import { walletFromRecoveryInput } from "../walletImport";
import "./Wallet.css";

type WalletView =
  | "home"
  | "send"
  | "receive"
  | "pay"
  | "payment"
  | "markets"
  | "marketDetail"
  | "swap"
  | "bridge"
  | "earn"
  | "borrow"
  | "activity"
  | "notifications"
  | "security";

type WalletMarket = {
  address: string;
  name: string;
  symbol: string;
  image?: string;
  reserve: string;
  virtualReserve: string;
  inventory: string;
  volume24h: string;
  priceChange24h: number;
  holderCount: number;
  tradeCount: number;
  trades?: Array<{ side: "BUY" | "SELL"; native: string; tokens: string; timestamp: number }>;
};

type Props = {
  account: string;
  chainId: number | null;
  activeProvider: EthereumProvider | null;
  connect: () => void;
  disconnect: () => void;
};

const short = (value: string) =>
  value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "Not connected";
const ARC_PAY_ABI = [
  "function pay(bytes32 invoiceId,address merchant,uint256 amount,uint64 expiresAt,address expectedPayer,bytes32 memoHash) payable",
];
const LEND_ABI = [
  "function supply() payable returns(uint256)",
  "function depositCollateral(uint256)",
  "function withdrawCollateral(uint256)",
  "function borrow(uint256)",
  "function repay(address) payable",
  "function supplyShares(address) view returns(uint256)",
  "function withdraw(uint256) returns(uint256)",
];
const ERC20_ABI = ["function approve(address,uint256) returns(bool)"];

// Circle CCTP v2 — deterministic addresses across every supported testnet chain.
const TOKEN_MESSENGER_V2 = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA";
const TOKEN_MESSENGER_ABI = [
  "function depositForBurn(uint256 amount,uint32 destinationDomain,bytes32 mintRecipient,address burnToken,bytes32 destinationCaller,uint256 maxFee,uint32 minFinalityThreshold) returns (uint64)",
];
const CCTP_USDC_ABI = [
  "function approve(address,uint256) returns(bool)",
  "function allowance(address,address) view returns(uint256)",
];
// Every chain Circle can burn-and-mint between. The wallet auto-selects the
// right one for each step, so the person never switches networks by hand.
const BRIDGE_CHAINS = CHAINS.filter((c) => CCTP_DOMAIN[c.id] !== undefined);
const chainById = (id: number) => BRIDGE_CHAINS.find((c) => c.id === id);
const chainLabel = (id: number) => chainById(id)?.name.replace(/\s*(Testnet|Sepolia)$/i, "") || "another chain";

export default function Wallet({
  account,
  chainId,
  activeProvider,
  connect,
  disconnect,
}: Props) {
  const native = isNativeWallet();
  const [nativeSecret, setNativeSecret] = useState<string | null>(null);
  const [vaultReady, setVaultReady] = useState(!native);
  const [locked, setLocked] = useState(native);
  const [biometric, setBiometric] = useState(false);
  const [notices, setNotices] = useState<WalletNotice[]>([]);
  const [setupMode, setSetupMode] = useState<"welcome" | "import" | "backup">(
    "welcome",
  );
  const [importValue, setImportValue] = useState("");
  const [recoveryPhrase, setRecoveryPhrase] = useState("");
  const nativeAccount = useMemo(() => {
    try {
      return nativeSecret ? new EthersWallet(nativeSecret).address : "";
    } catch {
      return "";
    }
  }, [nativeSecret]);
  const walletAccount = native ? nativeAccount : account;
  const [view, setView] = useState<WalletView>(() => {
    if (typeof window === "undefined") return "home";
    const host = window.location.hostname.split(".")[0];
    const requested = new URLSearchParams(window.location.search).get("view");
    if (requested === "pay") return "pay";
    if (requested === "earn") return "earn";
    return "home";
  });
  const [balance, setBalance] = useState("0.00");
  const [recipient, setRecipient] = useState("");
  const [contacts, setContacts] = useState<WalletContact[]>([]);
  const [contactName, setContactName] = useState("");
  const [recipientAcknowledged, setRecipientAcknowledged] = useState(false);
  const [p2pActivity, setP2pActivity] = useState<Array<{ tx: string; to: string; amount: string; status: "confirmed" | "failed"; at: number }>>([]);
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [status, setStatus] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [invoiceId, setInvoiceId] = useState(() => hexlify(randomBytes(32)));
  const [invoiceExpiry, setInvoiceExpiry] = useState(
    () => Math.floor(Date.now() / 1000) + 15 * 60,
  );
  const [pastedRequest, setPastedRequest] = useState("");
  const [paymentReceipt, setPaymentReceipt] = useState<null | { invoiceId: string; merchant: string; amount: string; memo: string; tx: string; paidAt: number }>(null);
  const [lendAmount, setLendAmount] = useState("");
  const [collateralAmount, setCollateralAmount] = useState("");
  const [bridgeMode, setBridgeMode] = useState<"send" | "claim">("send");
  const [bridgeFrom, setBridgeFrom] = useState<number>(ARC.id);
  const [bridgeTo, setBridgeTo] = useState<number>(BRIDGE_CHAINS.find((c) => c.id !== ARC.id)?.id ?? 11155111);
  const [bridgeAmount, setBridgeAmount] = useState("");
  const [bridgeRecipient, setBridgeRecipient] = useState("");
  const [claimHash, setClaimHash] = useState("");
  // When true, the app polls Circle for the attestation and claims automatically
  // as soon as it is ready — the user does not have to keep pressing Claim.
  const [autoClaim, setAutoClaim] = useState(false);
  const [busy, setBusy] = useState(false);
  const [walletMarkets, setWalletMarkets] = useState<WalletMarket[]>([]);
  const [selectedMarket, setSelectedMarket] = useState<WalletMarket | null>(null);
  const onArc = native || chainId === ARC.id;
  const contactKey = walletAccount ? `arcodian-address-book-v1:${walletAccount.toLowerCase()}` : "";
  const activityKey = walletAccount ? `arcodian-p2p-activity-v1:${walletAccount.toLowerCase()}` : "";
  const noticeKey = walletAccount ? `arcodian-wallet-notices-v1:${walletAccount.toLowerCase()}` : "";
  const recipientCheck = useMemo(() => {
    try { return recipient ? recipientSafety(recipient, contacts, walletAccount) : null; } catch { return null; }
  }, [recipient, contacts, walletAccount]);

  useEffect(() => {
    if (!contactKey) { setContacts([]); setP2pActivity([]); return; }
    try { setContacts(JSON.parse(localStorage.getItem(contactKey) || "[]")); } catch { setContacts([]); }
    try { setP2pActivity(JSON.parse(localStorage.getItem(activityKey) || "[]")); } catch { setP2pActivity([]); }
  }, [contactKey, activityKey]);

  useEffect(() => { setRecipientAcknowledged(false); }, [recipient]);

  useEffect(() => {
    if (!noticeKey) return setNotices([]);
    try { setNotices(JSON.parse(localStorage.getItem(noticeKey) || "[]")); } catch { setNotices([]); }
  }, [noticeKey]);

  function persistNotices(next: WalletNotice[]) {
    setNotices(next);
    if (noticeKey) localStorage.setItem(noticeKey, JSON.stringify(next));
  }

  async function unlockWallet() {
    try {
      if (!(await authenticateWallet("Confirm it is you to unlock your wallet"))) return;
      const secret = await loadWalletSecret();
      setNativeSecret(secret); setLocked(false); setStatus("");
    } catch (error) { setStatus(error instanceof Error ? error.message : "Wallet unlock cancelled"); }
  }

  function saveContact() {
    try {
      const address = normalizeRecipient(recipient);
      const name = contactName.trim().slice(0, 40);
      if (!name) throw new Error("Enter a contact name");
      const next = [{ name, address, favorite: false, lastUsedAt: Date.now() }, ...contacts.filter((item) => item.address.toLowerCase() !== address.toLowerCase())].slice(0, 100);
      localStorage.setItem(contactKey, JSON.stringify(next));
      setContacts(next); setContactName(""); setStatus(`${name} saved on this device`);
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not save contact"); }
  }

  useEffect(() => {
    let cancelled = false;
    fetch("/data/market-index.json", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((payload: { launches?: WalletMarket[] }) => {
        if (!cancelled) setWalletMarkets(Array.isArray(payload.launches) ? payload.launches : []);
      })
      .catch(() => { if (!cancelled) setWalletMarkets([]); });
    return () => { cancelled = true; };
  }, []);

  function openMarket(market: WalletMarket) {
    setSelectedMarket(market);
    setStatus("");
    setView("marketDetail");
  }

  function marketNumbers(market: WalletMarket) {
    const reserve = Number(formatEther(BigInt(market.reserve || "0")));
    const virtualReserve = Number(formatEther(BigInt(market.virtualReserve || "0")));
    const inventory = Number(formatEther(BigInt(market.inventory || "0")));
    const price = inventory > 0 ? (reserve + virtualReserve) / inventory : 0;
    return {
      price,
      marketCap: price * 1_000_000_000,
      liquidity: reserve,
      volume: Number(formatEther(BigInt(market.volume24h || "0"))),
    };
  }

  function chartPoints(market: WalletMarket) {
    const trades = market.trades || [];
    if (!trades.length) return "";
    const values = trades.slice(-24).map((trade) => {
      const native = Number(formatEther(BigInt(trade.native || "0")));
      const tokens = Number(formatEther(BigInt(trade.tokens || "0")));
      return tokens > 0 ? native / tokens : 0;
    });
    const min = Math.min(...values), max = Math.max(...values);
    return values.map((value, index) => {
      const x = values.length === 1 ? 50 : (index / (values.length - 1)) * 100;
      const y = max === min ? 45 : 82 - ((value - min) / (max - min)) * 64;
      return `${x},${y}`;
    }).join(" ");
  }

  async function scanArcPayQr() {
    if (!native) {
      setStatus("QR scanning is available in the Arcodian Android wallet");
      return;
    }
    setStatus("");
    setBusy(true);
    try {
      const support = await BarcodeScanner.isSupported();
      if (!support.supported) throw new Error("This device does not provide a supported camera scanner");
      const permission = await BarcodeScanner.requestPermissions();
      if (permission.camera !== "granted" && permission.camera !== "limited") {
        throw new Error("Camera permission is required to scan an Arc Pay QR");
      }
      const result = await BarcodeScanner.scan({
        formats: [BarcodeFormat.QrCode],
        autoZoom: true,
      });
      const value = result.barcodes[0]?.rawValue || result.barcodes[0]?.displayValue || "";
      if (!value) throw new Error("No QR payment request was detected");
      parseArcPayUri(value);
      setPastedRequest(value);
      setView("payment");
      setStatus("Arc Pay request scanned and validated");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "QR scan failed");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!native) return;
    Promise.all([loadWalletSecret(), biometricAvailable()])
      .then(([secret, available]) => { setBiometric(available); if (!secret) setLocked(false); else if (!available) setNativeSecret(secret); setLocked(Boolean(secret && available)); })
      .catch(() => setStatus("Android secure vault could not be opened"))
      .finally(() => setVaultReady(true));
  }, [native]);

  useEffect(() => {
    if (!native || !nativeSecret || locked) return;
    let lastActiveAt = Date.now();
    const active = () => { lastActiveAt = Date.now(); };
    const check = () => { if (document.hidden || shouldAutoLock(lastActiveAt, Date.now(), DEFAULT_AUTO_LOCK_MS)) { setNativeSecret(null); setLocked(true); } };
    for (const event of ["pointerdown", "keydown", "touchstart"] as const) window.addEventListener(event, active, { passive: true });
    document.addEventListener("visibilitychange", check);
    const timer = window.setInterval(check, 15_000);
    return () => { for (const event of ["pointerdown", "keydown", "touchstart"] as const) window.removeEventListener(event, active); document.removeEventListener("visibilitychange", check); window.clearInterval(timer); };
  }, [native, nativeSecret, locked]);

  useEffect(() => {
    const deep = new URLSearchParams(window.location.search).get("deeplink");
    if (!deep) return;
    const parsed = parseWalletDeepLink(deep);
    if (!parsed) return;
    if (parsed.view === "pay") { setPastedRequest(parsed.request); setView("payment"); }
    if (parsed.view === "bridge") { setClaimHash(parsed.burn); setBridgeMode("claim"); setView("bridge"); }
    if (parsed.view === "agentpay") window.location.assign(`/agentpay${parsed.vault ? `?vault=${encodeURIComponent(parsed.vault)}` : ""}`);
  }, []);

  useEffect(() => {
    if (!noticeKey) return;
    const incoming: WalletNotice[] = p2pActivity.map((row) => ({ id: `p2p:${row.tx}`, kind: row.status === "failed" ? "failure" : "payment", title: row.status === "failed" ? "Transfer failed" : "Payment confirmed", detail: `${row.amount} USDC to ${short(row.to)}`, createdAt: row.at, read: false, href: `${ARC.explorer}/tx/${row.tx}` }));
    if (paymentReceipt) incoming.push({ id: `arcpay:${paymentReceipt.tx}`, kind: "payment", title: "Arc Pay receipt confirmed", detail: `${paymentReceipt.amount} USDC to ${short(paymentReceipt.merchant)}`, createdAt: paymentReceipt.paidAt, read: false, href: `${ARC.explorer}/tx/${paymentReceipt.tx}` });
    const next = mergeWalletNotices(notices, incoming);
    if (JSON.stringify(next) !== JSON.stringify(notices)) persistNotices(next);
  }, [p2pActivity, paymentReceipt, noticeKey]);

  useEffect(() => {
    if (!noticeKey || !walletAccount) return;
    let cancelled = false;
    const sync = async () => {
      try {
        const response = await fetch(`/data/notifications.json?t=${Date.now()}`, { cache: "no-store" });
        if (!response.ok) return;
        const body = await response.json() as { alerts?: SystemAlert[] };
        if (cancelled) return;
        setNotices((current) => {
          const next = mergeWalletNotices(current, systemAlertsToWalletNotices(body.alerts || [], walletAccount));
          if (noticeKey) localStorage.setItem(noticeKey, JSON.stringify(next));
          return next;
        });
      } catch { /* monitoring feed is optional and fails silently */ }
    };
    void sync();
    const timer = window.setInterval(sync, 60_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [noticeKey, walletAccount]);

  useEffect(() => {
    if (!native) return;
    const root = document.documentElement;
    root.dataset.walletNative = "true";
    const syncViewport = () => {
      const width = window.visualViewport?.width ?? window.innerWidth;
      const height = window.visualViewport?.height ?? window.innerHeight;
      const layout =
        width > height
          ? "landscape"
          : width >= 700
            ? "tablet"
            : width <= 370
              ? "compact"
              : "phone";
      root.dataset.walletLayout = layout;
      root.style.setProperty("--wallet-viewport-height", `${height}px`);
    };
    syncViewport();
    window.addEventListener("resize", syncViewport);
    window.addEventListener("orientationchange", syncViewport);
    window.visualViewport?.addEventListener("resize", syncViewport);
    return () => {
      window.removeEventListener("resize", syncViewport);
      window.removeEventListener("orientationchange", syncViewport);
      window.visualViewport?.removeEventListener("resize", syncViewport);
      delete root.dataset.walletLayout;
      delete root.dataset.walletNative;
      root.style.removeProperty("--wallet-viewport-height");
    };
  }, [native]);

  async function signer() {
    if (nativeSecret)
      return new EthersWallet(nativeSecret, new JsonRpcProvider(ARC.rpc));
    if (activeProvider) return new BrowserProvider(activeProvider).getSigner();
    throw new Error("Create or import a wallet first");
  }

  // A signer bound to a specific chain. The native wallet talks to that chain's
  // RPC directly; an injected wallet is switched to it automatically — so a
  // bridge burn, approval, and claim each land on the right network with no
  // manual network-switching.
  async function signerFor(targetChainId: number) {
    const chain = chainById(targetChainId);
    if (!chain) throw new Error("This chain is not supported for bridging");
    if (nativeSecret)
      return new EthersWallet(nativeSecret, new JsonRpcProvider(chain.rpc));
    if (activeProvider) {
      const hex = `0x${targetChainId.toString(16)}`;
      try {
        await activeProvider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: hex }],
        });
      } catch (error) {
        const code =
          typeof error === "object" && error && "code" in error
            ? Number((error as { code?: unknown }).code)
            : 0;
        if (code === 4902 && targetChainId === ARC.id) {
          await activeProvider.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: hex,
                chainName: ARC.name,
                nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
                rpcUrls: [ARC.rpc],
                blockExplorerUrls: [ARC.explorer],
              },
            ],
          });
        } else if (code === 4902) {
          throw new Error(`Add ${chain.name} to your wallet, then try again.`);
        } else {
          throw error;
        }
      }
      return new BrowserProvider(activeProvider).getSigner();
    }
    throw new Error("Create or import a wallet first");
  }

  async function bridgeSend() {
    if (!walletAccount) {
      if (!native) connect();
      return;
    }
    if (!native && !activeProvider) return connect();
    if (bridgeFrom === bridgeTo) return setStatus("Pick two different chains.");
    setBusy(true);
    setStatus("");
    try {
      const from = chainById(bridgeFrom);
      const to = chainById(bridgeTo);
      if (!from || !to) throw new Error("Unsupported chain");
      const value = parseUnits(bridgeAmount || "0", 6); // CCTP USDC is 6-decimal
      if (value <= 0n) throw new Error("Enter an amount to bridge");
      const recipient = normalizeRecipient(bridgeRecipient || walletAccount);

      const bridgeSigner = await signerFor(from.id);
      const usdc = new Contract(from.token, CCTP_USDC_ABI, bridgeSigner);
      const owner = await bridgeSigner.getAddress();
      const allowance: bigint = await usdc.allowance(owner, TOKEN_MESSENGER_V2);
      if (allowance < value) {
        setStatus(`Approving USDC on ${chainLabel(from.id)}…`);
        const approval = await usdc.approve(TOKEN_MESSENGER_V2, value, {
          gasLimit: 120000n,
        });
        await approval.wait();
      }
      const messenger = new Contract(
        TOKEN_MESSENGER_V2,
        TOKEN_MESSENGER_ABI,
        bridgeSigner,
      );
      // Prefer CCTP Fast Transfer (soft finality → attested in seconds–minutes)
      // over Standard (hard finality, ~13–19 min). maxFee is only a *ceiling* —
      // the chain charges the real fast fee (~1bp); we cap generously at 1% so a
      // burn never reverts on an under-quoted fee. If the fast burn still reverts
      // (a lane that will not fast-finalise), fall back to a Standard burn, which
      // always succeeds. Either way the USDC burns exactly once.
      const fee = await fetchCctpFee(from.id, to.id);
      const fastFee = value / 100n > 0n ? value / 100n : 1n; // 1% ceiling, non-zero
      const attempts: Array<{ maxFee: bigint; threshold: number }> = [];
      if ((fee?.threshold ?? 2000) === 1000) attempts.push({ maxFee: fastFee, threshold: 1000 });
      attempts.push({ maxFee: 0n, threshold: 2000 }); // Standard fallback (always valid)

      setStatus(`Sending ${bridgeAmount} USDC from ${chainLabel(from.id)}…`);
      let tx;
      let usedThreshold = 2000;
      let lastError: unknown;
      for (let i = 0; i < attempts.length; i++) {
        const { maxFee, threshold } = attempts[i];
        try {
          tx = await messenger.depositForBurn(
            value,
            CCTP_DOMAIN[to.id],
            zeroPadValue(recipient, 32),
            from.token,
            ZeroHash,
            maxFee,
            threshold,
            { gasLimit: 300000n },
          );
          await tx.wait();
          usedThreshold = threshold;
          break; // burn confirmed
        } catch (burnError) {
          lastError = burnError;
          tx = undefined;
          if (i < attempts.length - 1) {
            setStatus("Fast transfer unavailable for this route — retrying with standard finality…");
          }
        }
      }
      if (!tx) throw lastError instanceof Error ? lastError : new Error("Burn failed on all transfer speeds");
      savePendingClaim(walletAccount, {
        burnHash: tx.hash,
        fromChainId: from.id,
        toChainId: to.id,
        amount: value.toString(),
        recipient,
      });
      setClaimHash(tx.hash);
      setBridgeMode("claim");
      setAutoClaim(true); // start polling + auto-claim on the destination
      setStatus(
        usedThreshold === 1000
          ? `Sent via Fast Transfer. Waiting for Circle, then claiming on ${chainLabel(to.id)} automatically…`
          : `Sent with standard finality (~15 min). It will claim on ${chainLabel(to.id)} automatically once ready.`,
      );
      setBridgeAmount("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Bridge failed");
    } finally {
      setBusy(false);
    }
  }

  async function bridgeClaim() {
    if (!walletAccount) {
      if (!native) connect();
      return;
    }
    if (!native && !activeProvider) return connect();
    setBusy(true);
    setStatus("");
    try {
      const to = chainById(bridgeTo);
      const from = chainById(bridgeFrom);
      if (!to || !from) throw new Error("Unsupported chain");
      if (!/^0x[a-fA-F0-9]{64}$/.test(claimHash))
        throw new Error("Paste the send transaction hash first");
      setStatus("Checking Circle attestation…");
      const attestation = await fetchCctpAttestation(from.id, claimHash);
      if (!attestation)
        throw new Error(
          "Circle has no record of this transfer yet — confirm the hash and source chain.",
        );
      if (!attestation.ready)
        throw new Error(
          `Circle is still confirming (${attestation.status}). Try again shortly.`,
        );
      const claimSigner = await signerFor(to.id);
      const transmitter = new Contract(
        MESSAGE_TRANSMITTER_V2,
        MESSAGE_TRANSMITTER_ABI,
        claimSigner,
      );
      setStatus(`Claiming on ${chainLabel(to.id)}…`);
      const tx = await transmitter.receiveMessage(
        attestation.message,
        attestation.attestation,
        { gasLimit: 350000n },
      );
      await tx.wait();
      recordBridgeHistory(walletAccount, { burnHash: claimHash, fromChainId: from.id, toChainId: to.id, amount: attestation.amount, recipient: walletAccount, status: "completed", mintHash: tx.hash, createdAt: Date.now() });
      clearPendingClaim(walletAccount, claimHash);
      const amount = attestation.amount
        ? `${formatUnits(BigInt(attestation.amount), 6)} USDC`
        : "Your USDC";
      setAutoClaim(false);
      setStatus(`Done — ${amount} arrived on ${chainLabel(to.id)}.`);
      setClaimHash("");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/already been received|nonce already used|already used/i.test(message)) {
        recordBridgeHistory(walletAccount, { burnHash: claimHash, fromChainId: bridgeFrom, toChainId: bridgeTo, recipient: walletAccount, status: "completed", note: "Destination mint was already completed.", createdAt: Date.now() });
        clearPendingClaim(walletAccount, claimHash);
        setAutoClaim(false);
        setStatus("Already claimed — the USDC is already on the destination chain.");
      } else setStatus(message.slice(0, 160));
    } finally {
      setBusy(false);
    }
  }

  // Auto-pilot for the claim leg: while a burn is pending, poll Circle for the
  // attestation and fire the claim the moment it is ready — so the user never
  // has to sit and re-press Claim. Works fully hands-off on the native wallet;
  // an injected wallet still prompts to switch network and sign the mint.
  useEffect(() => {
    if (!autoClaim || !/^0x[a-fA-F0-9]{64}$/.test(claimHash)) return;
    let stopped = false;
    let ticking = false;
    const poll = async () => {
      if (stopped || ticking || busy) return;
      ticking = true;
      try {
        const attestation = await fetchCctpAttestation(bridgeFrom, claimHash);
        if (stopped) return;
        if (attestation?.ready) {
          await bridgeClaim();
        } else {
          setStatus(
            `Circle is confirming the transfer (${attestation?.status || "pending"})… it will claim on ${chainLabel(bridgeTo)} automatically.`,
          );
        }
      } catch {
        /* transient network error — the next tick retries */
      } finally {
        ticking = false;
      }
    };
    void poll();
    const timer = setInterval(poll, 8000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoClaim, claimHash, bridgeFrom, bridgeTo]);

  async function createNativeWallet() {
    setStatus("");
    try {
      const created = EthersWallet.createRandom();
      if (!created.mnemonic)
        throw new Error("Recovery phrase generation failed");
      await saveWalletSecret(created.privateKey);
      setNativeSecret(created.privateKey);
      setRecoveryPhrase(created.mnemonic.phrase);
      setSetupMode("backup");
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Wallet creation failed",
      );
    }
  }

  async function importNativeWallet() {
    setStatus("");
    try {
      const imported = walletFromRecoveryInput(importValue);
      await saveWalletSecret(imported.privateKey);
      setNativeSecret(imported.privateKey);
      setImportValue("");
      setView("home");
    } catch {
      setStatus("Invalid recovery phrase or private key");
    }
  }

  async function removeNativeWallet() {
    await clearWalletSecret();
    setNativeSecret(null);
    setRecoveryPhrase("");
    setSetupMode("welcome");
    setView("home");
    setStatus("Wallet removed from this device");
  }

  useEffect(() => {
    if (!walletAccount || !onArc || (!native && !activeProvider)) {
      setBalance("0.00");
      return;
    }
    const provider = native
      ? new JsonRpcProvider(ARC.rpc)
      : new BrowserProvider(activeProvider!);
    let cancelled = false;
    provider
      .getBalance(walletAccount)
      .then((value) => {
        if (!cancelled)
          setBalance(
            Number(formatEther(value)).toLocaleString("en-US", {
              maximumFractionDigits: 4,
            }),
          );
      })
      .catch(() => {
        if (!cancelled) setBalance("—");
      });
    return () => {
      cancelled = true;
    };
  }, [walletAccount, activeProvider, onArc, native]);

  const receiveUri = useMemo(() => {
    if (!walletAccount)
      return "Create or import a wallet to create an Arc Pay request";
    try {
      const settlement =
        amount && ARC_PAY_ADDRESS
          ? {
              invoiceId,
              expiresAt: invoiceExpiry,
              chainId: ARC.id,
              contract: ARC_PAY_ADDRESS,
            }
          : undefined;
      return arcPayUri(walletAccount, amount, memo, settlement);
    } catch {
      return walletAccount;
    }
  }, [walletAccount, amount, memo, invoiceId, invoiceExpiry]);
  const feePreview = useMemo(() => {
    try {
      return amount
        ? `${formatEther(arcPayFee(parseArcNativeAmount(amount)))} USDC (0.30%)`
        : "—";
    } catch {
      return "Enter a valid amount";
    }
  }, [amount]);

  useEffect(() => {
    let cancelled = false;
    if (!walletAccount) {
      setQrDataUrl("");
      return;
    }
    QRCode.toDataURL(receiveUri, {
      width: 360,
      margin: 2,
      color: { dark: "#071021", light: "#ffffff" },
      errorCorrectionLevel: "M",
    })
      .then((value) => {
        if (!cancelled) setQrDataUrl(value);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl("");
      });
    return () => {
      cancelled = true;
    };
  }, [walletAccount, receiveUri]);

  async function switchToArc() {
    if (native) return;
    if (!activeProvider) return connect();
    setStatus("");
    try {
      await activeProvider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: ARC.hexId }],
      });
    } catch (error) {
      const code =
        typeof error === "object" && error && "code" in error
          ? Number((error as { code?: unknown }).code)
          : 0;
      if (code !== 4902) {
        setStatus(
          error instanceof Error ? error.message : "Could not switch network",
        );
        return;
      }
      try {
        await activeProvider.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: ARC.hexId,
              chainName: ARC.name,
              nativeCurrency: {
                name: "USDC",
                symbol: "USDC",
                decimals: ARC.nativeDecimals,
              },
              rpcUrls: [ARC.rpc],
              blockExplorerUrls: [ARC.explorer],
            },
          ],
        });
      } catch (addError) {
        setStatus(
          addError instanceof Error
            ? addError.message
            : "Could not add Arc Testnet",
        );
      }
    }
  }

  async function send() {
    if (!walletAccount) {
      if (!native) connect();
      return;
    }
    if (!native && !activeProvider) return connect();
    if (!onArc) return switchToArc();
    setBusy(true);
    setPaymentReceipt(null);
    setStatus("");
    try {
      const to = normalizeRecipient(recipient);
      const value = parseArcNativeAmount(amount);
      const walletSigner = await signer();
      const tx = await walletSigner.sendTransaction({ to, value });
      setStatus(`Submitted ${tx.hash.slice(0, 10)}…`);
      await tx.wait();
      const nextActivity = [{ tx: tx.hash, to, amount, status: "confirmed" as const, at: Date.now() }, ...p2pActivity].slice(0, 50);
      localStorage.setItem(activityKey, JSON.stringify(nextActivity));
      setP2pActivity(nextActivity);
      const usedContacts = contacts.map((item) => item.address.toLowerCase() === to.toLowerCase() ? { ...item, lastUsedAt: Date.now() } : item);
      localStorage.setItem(contactKey, JSON.stringify(usedContacts)); setContacts(usedContacts);
      setStatus(`Confirmed · ${tx.hash.slice(0, 10)}…`);
      setAmount("");
      setRecipient("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Transaction failed");
    } finally {
      setBusy(false);
    }
  }

  async function settleArcPayRequest() {
    if (!walletAccount) {
      if (!native) connect();
      return;
    }
    if (!native && !activeProvider) return connect();
    if (!onArc) return switchToArc();
    setBusy(true);
    setPaymentReceipt(null);
    setStatus("");
    try {
      if (!ARC_PAY_ADDRESS)
        throw new Error(
          "Arc Pay settlement contract is not deployed/configured yet",
        );
      const request = parseArcPayUri(pastedRequest);
      if (request.chainId !== ARC.id)
        throw new Error("Payment request is for the wrong network");
      if (request.expiresAt < Math.floor(Date.now() / 1000))
        throw new Error("Payment request has expired");
      if (request.contract.toLowerCase() !== ARC_PAY_ADDRESS.toLowerCase())
        throw new Error("Unrecognized Arc Pay settlement contract");
      const value = parseArcNativeAmount(request.amount);
      const walletSigner = await signer();
      const settlement = new Contract(
        ARC_PAY_ADDRESS,
        ARC_PAY_ABI,
        walletSigner,
      );
      const tx = await settlement.pay(
        request.invoiceId,
        request.recipient,
        value,
        request.expiresAt,
        ZeroAddress,
        request.memo ? id(request.memo) : ZeroHash,
        { value },
      );
      setStatus(`Payment submitted ${tx.hash.slice(0, 10)}…`);
      await tx.wait();
      setStatus(`Payment confirmed · ${tx.hash.slice(0, 10)}…`);
      const receipt = { invoiceId: request.invoiceId, merchant: request.recipient, amount: request.amount, memo: request.memo || "—", tx: tx.hash, paidAt: Date.now() };
      setPaymentReceipt(receipt);
      localStorage.setItem(`arcodian-payment-receipt:${tx.hash}`, JSON.stringify(receipt));
      setPastedRequest("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Payment failed");
    } finally {
      setBusy(false);
    }
  }

  function resetInvoice() {
    setInvoiceId(hexlify(randomBytes(32)));
    setInvoiceExpiry(Math.floor(Date.now() / 1000) + 15 * 60);
    setStatus("New 15-minute invoice created");
  }

  async function lendAction(
    action:
      | "supply"
      | "collateral"
      | "borrow"
      | "repay"
      | "withdrawCollateral"
      | "withdrawSupply",
  ) {
    if (!walletAccount) {
      if (!native) connect();
      return;
    }
    if (!native && !activeProvider) return connect();
    if (!onArc) return switchToArc();
    setBusy(true);
    setStatus("");
    try {
      if (!ARC_LEND_ADDRESS)
        throw new Error("Arc Lend market is not deployed/configured yet");
      const walletSigner = await signer();
      const market = new Contract(ARC_LEND_ADDRESS, LEND_ABI, walletSigner);
      let tx;
      if (action === "supply") {
        const value = parseArcNativeAmount(lendAmount);
        tx = await market.supply({ value });
      } else if (action === "borrow") {
        tx = await market.borrow(parseArcNativeAmount(lendAmount));
      } else if (action === "repay") {
        const value = parseArcNativeAmount(lendAmount);
        tx = await market.repay(walletAccount, { value });
      } else if (action === "withdrawSupply") {
        const shares = await market.supplyShares(walletAccount);
        if (shares === 0n) throw new Error("No supply shares to withdraw");
        tx = await market.withdraw(shares);
      } else if (action === "withdrawCollateral") {
        tx = await market.withdrawCollateral(parseUnits(collateralAmount, 6));
      } else {
        if (!ARC_LEND_COLLATERAL_ADDRESS)
          throw new Error("Collateral token is not configured");
        const value = parseUnits(collateralAmount, 6);
        const token = new Contract(
          ARC_LEND_COLLATERAL_ADDRESS,
          ERC20_ABI,
          walletSigner,
        );
        const approval = await token.approve(ARC_LEND_ADDRESS, value);
        await approval.wait();
        tx = await market.depositCollateral(value);
      }
      setStatus(`Submitted ${tx.hash.slice(0, 10)}…`);
      await tx.wait();
      setStatus(`${action} confirmed · ${tx.hash.slice(0, 10)}…`);
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Lending action failed",
      );
    } finally {
      setBusy(false);
    }
  }

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setStatus(`${label} copied`);
    } catch {
      setStatus("Copy failed. Select the text manually.");
    }
  }

  return (
    <section className="arc-wallet-shell wallet-superapp">
      <header className="arc-wallet-header">
        <div>
          <img src="/arcodian-mark.svg" alt="" />
          <span>
            <b>ARCODIAN</b>
            <small>WALLET · TESTNET</small>
          </span>
        </div>
        {walletAccount ? (
          <button onClick={() => setView("security")}>
            {short(walletAccount)}
          </button>
        ) : native ? (
          <span className="wallet-arc-lock">ARC NATIVE</span>
        ) : (
          <button className="wallet-connect" onClick={connect}>
            Connect wallet
          </button>
        )}
      </header>

      <main className="arc-wallet-phone">
        {native && !vaultReady ? (
          <section className="wallet-welcome wallet-vault-loading">
            <img src="/arcodian-mark.svg" alt="Arcodian" />
            <p>ANDROID SECURE VAULT</p>
            <h1>Unlocking your wallet…</h1>
          </section>
        ) : native && locked ? (
          <section className="wallet-welcome wallet-native-setup wallet-locked">
            <img src="/arcodian-mark.svg" alt="Arcodian" />
            <p>SECURE AUTO-LOCK</p><h1>Wallet locked.</h1>
            <span>{biometric ? "Use biometrics or your device credential to continue." : "Unlock the secure wallet on this device."}</span>
            <button onClick={() => void unlockWallet()}>Unlock wallet</button>
          </section>
        ) : native && recoveryPhrase ? (
          <section className="wallet-form wallet-backup">
            <p className="wallet-eyebrow">RECOVERY PHRASE · SHOW ONCE</p>
            <h2>Back up these 12 words</h2>
            <div className="wallet-seed-grid">
              {recoveryPhrase.split(" ").map((word, index) => (
                <span key={`${word}-${index}`}>
                  <i>{index + 1}</i>
                  {word}
                </span>
              ))}
            </div>
            <article>
              <b>Keep it offline</b>
              <small>
                Anyone with these words can control this wallet. Arcodian cannot
                recover them.
              </small>
            </article>
            <button
              className="wallet-primary"
              onClick={() => {
                setRecoveryPhrase("");
                setView("home");
              }}
            >
              I saved it securely
            </button>
          </section>
        ) : !walletAccount && view === "home" ? (
          native ? (
            <section className="wallet-welcome wallet-native-setup">
              <img src="/arcodian-mark.svg" alt="Arcodian" />
              <p>MONEY WITHOUT BORDERS</p>
              <h1>
                {setupMode === "import"
                  ? "Import your wallet."
                  : "Meet Arcodian."}
              </h1>
              {setupMode === "import" ? (
                <>
                  <span>
                    Enter a valid 12/24-word EVM recovery phrase or private key.
                    It is encrypted immediately with Android Keystore and never
                    sent to Arcodian.
                  </span>
                  <textarea
                    value={importValue}
                    onChange={(event) => setImportValue(event.target.value)}
                    placeholder="Recovery phrase or private key"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <button
                    disabled={!importValue.trim()}
                    onClick={importNativeWallet}
                  >
                    Import wallet
                  </button>
                  <button
                    className="wallet-setup-secondary"
                    onClick={() => {
                      setSetupMode("welcome");
                      setImportValue("");
                      setStatus("");
                    }}
                  >
                    Back
                  </button>
                </>
              ) : (
                <>
                  <span>
                    Your self-custody wallet for stablecoin payments, swaps, and
                    onchain credit on Arc.
                  </span>
                  <button onClick={createNativeWallet}>
                    Create a new wallet
                  </button>
                  <button
                    className="wallet-setup-secondary"
                    onClick={() => setSetupMode("import")}
                  >
                    Import existing wallet
                  </button>
                  <small>
                    Arc Testnet only · EVM 12/24 words or private key
                  </small>
                </>
              )}
            </section>
          ) : (
            <section className="wallet-welcome">
              <img src="/arcodian-mark.svg" alt="Arcodian" />
              <p>YOUR MONEY. YOUR KEYS.</p>
              <h1>
                A calmer way
                <br />
                to move on Arc.
              </h1>
              <span>
                Connect an existing self-custody wallet. Arcodian never receives
                your recovery phrase.
              </span>
              <button onClick={connect}>Connect wallet</button>
            </section>
          )
        ) : (
          <>
            {view === "home" && (
              <section className="wallet-home">
                <div className="wallet-home-intro">
                  <span>GOOD TO SEE YOU</span>
                  <b>Your Arc portfolio</b>
                </div>
                <div className="wallet-network">
                  <i />
                  Arc Testnet <span>Chain {ARC.id}</span>
                </div>
                <p>Total balance</p>
                <h1>
                  {balance} <small>USDC</small>
                </h1>
                <small className="wallet-balance-caption">
                  Native settlement balance · Arc Testnet
                </small>
                <div className="wallet-actions wallet-actions-four">
                  <button onClick={() => setView("send")}>
                    <i>↗</i>Send
                  </button>
                  <button onClick={() => setView("receive")}>
                    <i>↙</i>Receive
                  </button>
                  <button className="wallet-action-accent" onClick={() => setView("bridge")}>
                    <i>⧉</i>Bridge
                  </button>
                  <button onClick={() => setView("markets")}>
                    <i>◇</i>Markets
                  </button>
                </div>
                {!onArc && (
                  <button
                    className="wallet-network-warning"
                    onClick={switchToArc}
                  >
                    Switch wallet to Arc Testnet
                  </button>
                )}
                <article className="wallet-asset">
                  <img src="/arcodian-mark.svg" alt="" />
                  <span>
                    <b>USDC</b>
                    <small>Native gas & settlement</small>
                  </span>
                  <strong>{balance}</strong>
                </article>
                <div className="wallet-section-title">
                  <b>Discover</b>
                  <span>Built into Arcodian</span>
                </div>
                <article className="wallet-card">
                  <span>Arc Pay</span>
                  <b>Pay globally. Settle instantly.</b>
                  <small>Scan an Arcodian QR and pay with native USDC.</small>
                  <button onClick={() => setView("pay")}>Open scanner →</button>
                </article>
                <button
                  className="wallet-activity-link"
                  onClick={() => setView("activity")}
                >
                  Recent activity <span>View all →</span>
                </button>
                <button className="wallet-activity-link" onClick={() => setView("notifications")}>
                  Notifications <span>{notices.filter((row) => !row.read).length || "All clear"} →</span>
                </button>
              </section>
            )}

            {view === "send" && (
              <section className="wallet-form">
                <p className="wallet-eyebrow">SEND</p>
                <h2>Move USDC</h2>
                <label>
                  Recipient
                  <input
                    value={recipient}
                    onChange={(e) => setRecipient(e.target.value)}
                    placeholder="0x…"
                  />
                </label>
                {contacts.length > 0 && <div className="wallet-contact-chips">{contacts.slice().sort((a,b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0)).slice(0, 6).map((item) => <button key={item.address} onClick={() => setRecipient(item.address)}><b>{item.name}</b><small>{recipientFingerprint(item.address)}</small></button>)}</div>}
                {recipientCheck && <aside className={`wallet-recipient-check ${recipientCheck.level}`}><b>{recipientCheck.level === "trusted" ? "Verified contact" : recipientCheck.level === "danger" ? "Address mismatch" : "Check recipient"}</b><span>{recipientCheck.message}</span><code>{normalizeRecipient(recipient)}</code>{recipientCheck.level !== "trusted" && <label><input type="checkbox" checked={recipientAcknowledged} onChange={(event) => setRecipientAcknowledged(event.target.checked)} /> I checked the full address</label>}</aside>}
                {recipientCheck?.code === "new" && <div className="wallet-save-contact"><input value={contactName} onChange={(event) => setContactName(event.target.value)} placeholder="Contact name" /><button onClick={saveContact}>Save contact</button></div>}
                <label>
                  Amount
                  <div>
                    <input
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="0.00"
                    />
                    <b>USDC</b>
                  </div>
                </label>
                <article>
                  <span>Arcodian fee</span>
                  <b>0 USDC</b>
                  <small>Only Arc network gas applies.</small>
                </article>
                <button
                  className="wallet-primary"
                  disabled={busy || !recipientCheck || (recipientCheck.level !== "trusted" && !recipientAcknowledged)}
                  onClick={send}
                >
                  {busy
                    ? "Waiting for wallet…"
                    : onArc
                      ? "Review in wallet"
                      : "Switch to Arc Testnet"}
                </button>
              </section>
            )}

            {view === "receive" && (
              <section className="wallet-form wallet-receive">
                <p className="wallet-eyebrow">RECEIVE</p>
                <h2>Your Arc address</h2>
                {qrDataUrl ? (
                  <img
                    src={qrDataUrl}
                    alt="QR code for Arc wallet address"
                    style={{
                      display: "block",
                      width: 184,
                      height: 184,
                      margin: "25px auto",
                      padding: 8,
                      borderRadius: 22,
                      background: "#fff",
                      boxShadow: "0 20px 50px #0008",
                    }}
                  />
                ) : (
                  <div
                    className="qr-placeholder"
                    aria-label="Generating payment QR"
                  >
                    <i>AC</i>
                  </div>
                )}
                <code>{walletAccount}</code>
                <button
                  className="wallet-primary"
                  onClick={() => copy(walletAccount, "Address")}
                >
                  Copy address
                </button>
                <label>
                  Request amount
                  <div>
                    <input
                      inputMode="decimal"
                      value={amount}
                      onChange={(event) => setAmount(event.target.value)}
                      placeholder="0.00"
                    />
                    <b>USDC</b>
                  </div>
                </label>
                <small>
                  Only send supported Arc Testnet assets to this address.
                </small>
              </section>
            )}

            {view === "pay" && (
              <section className="wallet-form wallet-pay-hub">
                <p className="wallet-eyebrow">ARC PAY · ENCRYPTED SCAN</p>
                <h2>Scan to pay</h2>
                <div className="wallet-scan-frame">
                  <i>⌗</i>
                  <span>Native QR scanner · camera permission required</span>
                </div>
                <div className="wallet-pay-actions">
                  <button disabled={busy} onClick={scanArcPayQr}>
                    {busy ? "Opening camera…" : "⌗ Scan QR"}
                  </button>
                  <button onClick={() => setView("payment")}>
                    ⌁ Enter request
                  </button>
                  <button onClick={() => setView("receive")}>
                    ▣ Create invoice
                  </button>
                </div>
                <label>
                  Payment request
                  <textarea
                    value={pastedRequest}
                    onChange={(e) => setPastedRequest(e.target.value)}
                    placeholder="Paste arcodian:pay/… request"
                  />
                </label>
                <button
                  className="wallet-primary"
                  disabled={!pastedRequest}
                  onClick={() => setView("payment")}
                >
                  Review payment
                </button>
                <small>
                  Every request is checked for chain, contract, amount, invoice
                  ID, and expiry before signing.
                </small>
              </section>
            )}

            {view === "payment" && (
              <section className="wallet-form wallet-payment-review">
                <p className="wallet-eyebrow">CONFIRM PAYMENT</p>
                <div className="wallet-merchant">AC</div>
                <h2>Arc Pay invoice</h2>
                <p>Review the exact request before your wallet signs it.</p>
                <article>
                  <span>Network</span>
                  <b>Arc Testnet</b>
                  <small>
                    Settlement contract verified in app configuration.
                  </small>
                </article>
                <article>
                  <span>Protocol fee</span>
                  <b>0.30%</b>
                  <small>Merchant receives 99.70% immediately.</small>
                </article>
                {paymentReceipt && <article className="wallet-payment-receipt">
                  <span>Payment receipt</span>
                  <b>{paymentReceipt.amount} USDC · Confirmed</b>
                  <small>Merchant {short(paymentReceipt.merchant)} · Invoice {short(paymentReceipt.invoiceId)}</small>
                  <small>Memo {paymentReceipt.memo} · {new Date(paymentReceipt.paidAt).toLocaleString()}</small>
                  <a href={`${ARC.explorer}/tx/${paymentReceipt.tx}`} target="_blank" rel="noreferrer">View transaction {short(paymentReceipt.tx)} ↗</a>
                </article>}
                <button
                  className="wallet-primary"
                  disabled={busy || !pastedRequest || !ARC_PAY_ADDRESS}
                  onClick={settleArcPayRequest}
                >
                  {busy
                    ? "Signing on Arc…"
                    : !walletAccount
                      ? "Create or import wallet"
                      : "Hold to pay"}
                </button>
                <button
                  className="wallet-text-button"
                  onClick={() => setView("pay")}
                >
                  Back to scanner
                </button>
              </section>
            )}

            {view === "markets" && (
              <section className="wallet-form wallet-markets">
                <p className="wallet-eyebrow">ARC MARKETS · LIVE ONCHAIN</p>
                <h2>Discover assets</h2>
                <div className="wallet-market-tabs"><button className="active">All</button><button>Stablecoins</button><button>Community</button></div>
                <button className="wallet-market-row wallet-market-button" onClick={() => setView("swap")}>
                  <i className="usdc">$</i>
                  <span>
                    <b>USDC</b>
                    <small>Native gas & settlement</small>
                  </span>
                  <strong>$1.00<small>Swap ↗</small></strong>
                </button>
                <button className="wallet-market-row wallet-market-button" onClick={() => setView("swap")}>
                  <i className="eurc">€</i>
                  <span>
                    <b>EURC</b>
                    <small>Official Arc collateral</small>
                  </span>
                  <strong>Live<small>Swap ↗</small></strong>
                </button>
                <div className="wallet-section-title"><b>Community markets</b><span>{walletMarkets.length} indexed</span></div>
                {walletMarkets.map((market) => {
                  const metrics = marketNumbers(market);
                  return <button key={market.address} className="wallet-market-row wallet-market-button" onClick={() => openMarket(market)}>
                    {market.image ? <img src={market.image} alt=""/> : <i>{market.symbol.slice(0,2)}</i>}
                    <span><b>{market.symbol}</b><small>{market.name} · {market.holderCount} holders</small></span>
                    <strong>{metrics.price ? `$${metrics.price.toPrecision(3)}` : "New"}<small className={market.priceChange24h >= 0 ? "up" : "down"}>{market.priceChange24h >= 0 ? "+" : ""}{market.priceChange24h.toFixed(2)}%</small></strong>
                  </button>;
                })}
                {!walletMarkets.length && <div className="wallet-market-empty">No indexed community market is available right now.</div>}
              </section>
            )}

            {view === "marketDetail" && selectedMarket && (() => {
              const metrics = marketNumbers(selectedMarket);
              const points = chartPoints(selectedMarket);
              return <section className="wallet-form wallet-market-detail">
                <button className="wallet-back" onClick={() => setView("markets")}>← Markets</button>
                <div className="wallet-coin-head">
                  {selectedMarket.image ? <img src={selectedMarket.image} alt=""/> : <i>{selectedMarket.symbol.slice(0,2)}</i>}
                  <span><b>{selectedMarket.name}</b><small>${selectedMarket.symbol} · Arc Testnet</small></span>
                  <button onClick={() => copy(selectedMarket.address, "Token address")}>⧉</button>
                </div>
                <div className="wallet-coin-price"><h2>{metrics.price ? `$${metrics.price.toPrecision(5)}` : "Price pending"}</h2><b className={selectedMarket.priceChange24h >= 0 ? "up" : "down"}>{selectedMarket.priceChange24h >= 0 ? "+" : ""}{selectedMarket.priceChange24h.toFixed(2)}% 24h</b></div>
                <div className="wallet-chart">
                  <div><span>PRICE · 24H</span><small>Onchain confirmed trades</small></div>
                  {points ? <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="24 hour price chart"><defs><linearGradient id="walletChartFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#31dfe8" stopOpacity=".32"/><stop offset="1" stopColor="#31dfe8" stopOpacity="0"/></linearGradient></defs><polyline points={`${points} 100,100 0,100`} fill="url(#walletChartFill)" stroke="none"/><polyline points={points} fill="none" stroke="#35e2eb" strokeWidth="2.2" vectorEffect="non-scaling-stroke"/></svg> : <div className="wallet-chart-empty"><b>First candle pending</b><small>No confirmed trade history yet.</small></div>}
                </div>
                <div className="wallet-market-stats">
                  <span><small>Market cap</small><b>${metrics.marketCap.toLocaleString(undefined,{maximumFractionDigits:2})}</b></span>
                  <span><small>24h volume</small><b>{metrics.volume.toLocaleString(undefined,{maximumFractionDigits:4})} USDC</b></span>
                  <span><small>Liquidity</small><b>{metrics.liquidity.toLocaleString(undefined,{maximumFractionDigits:4})} USDC</b></span>
                  <span><small>Trades</small><b>{selectedMarket.tradeCount}</b></span>
                </div>
                <div className="wallet-trade-actions"><a href={`https://arcodian.fun/coin/${selectedMarket.address}?side=buy`}>Buy</a><a href={`https://arcodian.fun/coin/${selectedMarket.address}?side=sell`}>Sell</a><button onClick={() => setView("swap")}>Swap</button></div>
                <article><span>Contract</span><b>{short(selectedMarket.address)}</b><small>Permissionless Arc market. Verify the token before signing.</small></article>
              </section>;
            })()}

            {view === "swap" && (
              <section className="wallet-form wallet-swap">
                <p className="wallet-eyebrow">SWAP · BEST ROUTE</p>
                <h2>Stablecoin swap</h2>
                <label>
                  You pay
                  <div>
                    <input
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="0.00"
                    />
                    <b>USDC</b>
                  </div>
                </label>
                <button className="wallet-swap-direction">⇅</button>
                <label>
                  You receive
                  <div>
                    <input
                      readOnly
                      value={amount ? (Number(amount) * 0.8506).toFixed(2) : ""}
                      placeholder="0.00"
                    />
                    <b>EURC</b>
                  </div>
                </label>
                <article>
                  <span>Indicative rate</span>
                  <b>1 USDC ≈ 0.8506 EURC</b>
                  <small>
                    Final quote, impact, and minimum received are shown by
                    Arcodian Swap.
                  </small>
                </article>
                <a
                  className="wallet-primary wallet-link-button"
                  href="https://arcodian.fun/swap"
                >
                  Open executable quote
                </a>
              </section>
            )}

            {view === "bridge" && (
              <section className="wallet-form wallet-bridge">
                <p className="wallet-eyebrow">BRIDGE · CIRCLE CCTP</p>
                <h2>Move USDC across chains</h2>
                <div className="wallet-bridge-modes">
                  <button
                    className={bridgeMode === "send" ? "active" : ""}
                    onClick={() => {
                      setBridgeMode("send");
                      setStatus("");
                    }}
                  >
                    Send
                  </button>
                  <button
                    className={bridgeMode === "claim" ? "active" : ""}
                    onClick={() => {
                      setBridgeMode("claim");
                      setStatus("");
                    }}
                  >
                    Claim
                  </button>
                </div>

                <div className="wallet-bridge-route">
                  <label>
                    <span>FROM</span>
                    <select
                      value={bridgeFrom}
                      onChange={(e) => setBridgeFrom(Number(e.target.value))}
                    >
                      {BRIDGE_CHAINS.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="wallet-bridge-flip"
                    aria-label="Swap direction"
                    onClick={() => {
                      setBridgeFrom(bridgeTo);
                      setBridgeTo(bridgeFrom);
                    }}
                  >
                    ⇄
                  </button>
                  <label>
                    <span>TO</span>
                    <select
                      value={bridgeTo}
                      onChange={(e) => setBridgeTo(Number(e.target.value))}
                    >
                      {BRIDGE_CHAINS.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                {bridgeMode === "send" ? (
                  <>
                    <label>
                      Amount
                      <div>
                        <input
                          inputMode="decimal"
                          value={bridgeAmount}
                          onChange={(e) => setBridgeAmount(e.target.value)}
                          placeholder="0.00"
                        />
                        <b>USDC</b>
                      </div>
                    </label>
                    <label>
                      Recipient on {chainLabel(bridgeTo)}
                      <input
                        value={bridgeRecipient}
                        onChange={(e) => setBridgeRecipient(e.target.value)}
                        placeholder={walletAccount || "0x…"}
                      />
                    </label>
                    <article>
                      <span>Auto network switch</span>
                      <small>
                        Arcodian approves and burns on {chainLabel(bridgeFrom)},
                        then Circle mints the same USDC on {chainLabel(bridgeTo)}.
                        The wallet moves to each network for you — nothing is lost
                        in transit.
                      </small>
                    </article>
                    <button
                      className="wallet-primary"
                      disabled={busy || !bridgeAmount || bridgeFrom === bridgeTo}
                      onClick={bridgeSend}
                    >
                      {busy
                        ? "Working…"
                        : `Bridge to ${chainLabel(bridgeTo)}`}
                    </button>
                  </>
                ) : (
                  <>
                    <label>
                      Send transaction hash
                      <input
                        value={claimHash}
                        onChange={(e) => {
                          setClaimHash(e.target.value.trim());
                          setAutoClaim(false);
                        }}
                        placeholder="0x…"
                      />
                    </label>
                    {autoClaim ? (
                      <article className="wallet-bridge-auto">
                        <span>
                          <i className="wallet-bridge-spinner" />
                          Auto-claiming on {chainLabel(bridgeTo)}
                        </span>
                        <small>
                          Waiting for Circle's attestation, then minting your USDC
                          automatically. You can leave this open — it will not burn
                          twice. Make sure you hold a little gas on{" "}
                          {chainLabel(bridgeTo)} for the mint.
                        </small>
                      </article>
                    ) : (
                      <article>
                        <span>Claim on {chainLabel(bridgeTo)}</span>
                        <small>
                          Paste the send hash from {chainLabel(bridgeFrom)}. Arcodian
                          checks Circle's attestation and mints your USDC on{" "}
                          {chainLabel(bridgeTo)} — switching networks automatically.
                          The destination mint needs a little gas on{" "}
                          {chainLabel(bridgeTo)}.
                        </small>
                      </article>
                    )}
                    <button
                      className="wallet-primary"
                      disabled={busy || !claimHash || bridgeFrom === bridgeTo}
                      onClick={bridgeClaim}
                    >
                      {busy
                        ? "Working…"
                        : autoClaim
                          ? `Claim now on ${chainLabel(bridgeTo)}`
                          : `Claim on ${chainLabel(bridgeTo)}`}
                    </button>
                  </>
                )}
              </section>
            )}

            {view === "earn" && (
              <section className="wallet-form wallet-coming">
                <p className="wallet-eyebrow">EARN · ISOLATED MARKETS</p>
                <h2>Supply and borrow</h2>
                <div className="wallet-earn-balance">
                  <small>YOUR SUPPLIED BALANCE</small>
                  <b>
                    {walletAccount
                      ? `${lendAmount || "0.00"} USDC`
                      : "Wallet required"}
                  </b>
                  <span>
                    Yield comes from borrower interest—not guaranteed returns.
                  </span>
                </div>
                <div className="wallet-pay-actions">
                  <button
                    onClick={() =>
                      lendAmount
                        ? lendAction("supply")
                        : setStatus("Enter a USDC amount first")
                    }
                  >
                    ＋ Supply
                  </button>
                  <button onClick={() => lendAction("withdrawSupply")}>
                    − Withdraw
                  </button>
                </div>
                <label>
                  USDC amount
                  <input
                    inputMode="decimal"
                    value={lendAmount}
                    onChange={(e) => setLendAmount(e.target.value)}
                    placeholder="0.00"
                  />
                </label>
                <div className="wallet-market-row">
                  <i className="usdc">$</i>
                  <span>
                    <b>USDC Core</b>
                    <small>Low risk · capped market</small>
                  </span>
                  <strong>4.82%</strong>
                </div>
                <div className="wallet-market-row">
                  <i className="eurc">€</i>
                  <span>
                    <b>EURC collateral</b>
                    <small>Official Arc asset</small>
                  </span>
                  <button onClick={() => setView("borrow")}>Borrow →</button>
                </div>
                <small>
                  70% max LTV · 80% liquidation threshold · 5% liquidation bonus
                  · capped market.
                </small>
              </section>
            )}

            {view === "borrow" && (
              <section className="wallet-form wallet-borrow">
                <p className="wallet-eyebrow">BORROW USDC</p>
                <h2>Review position health</h2>
                <label>
                  Borrow amount
                  <div>
                    <input
                      inputMode="decimal"
                      value={lendAmount}
                      onChange={(e) => setLendAmount(e.target.value)}
                      placeholder="0.00"
                    />
                    <b>USDC</b>
                  </div>
                </label>
                <label>
                  EURC collateral
                  <input
                    inputMode="decimal"
                    value={collateralAmount}
                    onChange={(e) => setCollateralAmount(e.target.value)}
                    placeholder="0.00"
                  />
                </label>
                <article>
                  <span>Maximum LTV</span>
                  <b>70%</b>
                  <small>
                    Liquidation begins at 80%. Oracle must be fresher than one
                    hour.
                  </small>
                </article>
                <div className="wallet-borrow-actions">
                  <button
                    className="wallet-primary"
                    disabled={busy || !collateralAmount}
                    onClick={() => lendAction("collateral")}
                  >
                    Deposit EURC
                  </button>
                  <button
                    className="wallet-primary"
                    disabled={busy || !lendAmount}
                    onClick={() => lendAction("borrow")}
                  >
                    Review borrow
                  </button>
                  <button
                    className="wallet-text-button"
                    onClick={() => lendAction("repay")}
                  >
                    Repay existing debt
                  </button>
                </div>
              </section>
            )}

            {view === "activity" && (
              <section className="wallet-form wallet-activity">
                <p className="wallet-eyebrow">ACTIVITY · SYNCED</p>
                <h2>Wallet history</h2>
                <div className="wallet-filter">
                  <button className="active">All</button>
                  <button>Payments</button>
                  <button>DeFi</button>
                </div>
                {p2pActivity.map((row) => (
                  <article key={row.tx}>
                    <i>↗</i>
                    <span>
                      <b>USDC sent</b>
                      <small>{short(row.to)} · {new Date(row.at).toLocaleString()}</small>
                    </span>
                    <strong>−{row.amount} USDC<br/><a href={`${ARC.explorer}/tx/${row.tx}`} target="_blank" rel="noreferrer">Confirmed ↗</a></strong>
                  </article>
                ))}
                {!p2pActivity.length && <small>No P2P transfers recorded on this device yet.</small>}
                <small>
                  Activity is reconciled against Arc. This preview does not
                  invent balances or transaction hashes.
                </small>
              </section>
            )}

            {view === "notifications" && (
              <section className="wallet-form wallet-notifications">
                <p className="wallet-eyebrow">NOTIFICATION CENTER</p><h2>Needs your attention</h2>
                {notices.map((row) => <article key={row.id} className={row.read ? "read" : ""}><i>{row.kind === "failure" ? "!" : row.kind === "bridge" ? "⇄" : "✓"}</i><span><b>{row.title}</b><small>{row.detail} · {new Date(row.createdAt).toLocaleString()}</small></span>{row.href && <a href={row.href} target="_blank" rel="noreferrer">View ↗</a>}</article>)}
                {!notices.length && <small>No payment, bridge, policy, or security alerts.</small>}
                {!!notices.length && <button className="wallet-text-button" onClick={() => persistNotices(notices.map((row) => ({ ...row, read: true })))}>Mark all read</button>}
              </section>
            )}

            {view === "security" && (
              <section className="wallet-form wallet-security">
                <p className="wallet-eyebrow">SECURITY & RECOVERY</p>
                <h2>Protect your wallet</h2>
                <div className="wallet-security-score">
                  <small>SECURITY SCORE</small>
                  <b>
                    {walletAccount ? "Encrypted on device" : "Setup required"}
                  </b>
                  <span>
                    Arcodian never receives a recovery phrase or private key.
                  </span>
                </div>
                <article>
                  <span>Secret storage</span>
                  <b>
                    {native
                      ? "Android Keystore · AES-GCM"
                      : "External self-custody"}
                  </b>
                  <small>
                    Raw wallet material is never written to localStorage or
                    server logs.
                  </small>
                </article>
                <article>
                  <span>Network protection</span>
                  <b>Arc home · Circle-only bridging</b>
                  <small>
                    Everyday balances live on Arc. Cross-chain moves go only
                    through Circle's CCTP burn-and-mint — no third-party bridge.
                  </small>
                </article>
                <article>
                  <span>Backup</span>
                  <b>User-controlled recovery</b>
                  <small>
                    Keep the 12/24 words or imported private key offline.
                  </small>
                </article>
                <button
                  className="wallet-primary wallet-danger"
                  onClick={
                    native
                      ? removeNativeWallet
                      : walletAccount
                        ? disconnect
                        : connect
                  }
                >
                  {native
                    ? "Remove wallet from device"
                    : walletAccount
                      ? "Disconnect wallet"
                      : "Connect wallet"}
                </button>
              </section>
            )}

            {status && <p className="wallet-status">{status}</p>}
          </>
        )}
      </main>

      {!walletAccount && status && (
        <p className="wallet-status wallet-setup-status">{status}</p>
      )}
      {walletAccount && (
        <nav className="arc-wallet-tabs">
          {(["home", "swap", "bridge", "pay", "earn"] as WalletView[]).map(
            (item) => (
              <button
                key={item}
                className={
                  view === item ||
                  (item === "home" &&
                    (view === "markets" ||
                      view === "marketDetail" ||
                      view === "send" ||
                      view === "receive" ||
                      view === "activity" ||
                      view === "notifications" ||
                      view === "security")) ||
                  (item === "earn" && view === "borrow")
                    ? "active"
                    : ""
                }
                onClick={() => {
                  setView(item);
                  setStatus("");
                }}
              >
                <i>
                  {item === "home"
                    ? "⌂"
                    : item === "swap"
                      ? "⇄"
                      : item === "bridge"
                        ? "⧉"
                        : item === "pay"
                          ? "⌗"
                          : "◈"}
                </i>
                {item}
              </button>
            ),
          )}
        </nav>
      )}
    </section>
  );
}

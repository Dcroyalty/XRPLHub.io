"use client";
// app/checkout/CheckoutFlow.tsx
// The whole buy flow, shared by /checkout (full page) and the /pricing modal.
//
//   1. pick XRP or RLUSD            -> (re)creates an Invoice with a unique dest tag
//   2. "Pay with Xaman"            -> POST /api/checkout/xaman -> sign request
//                                      pre-filled with amount + destination + tag
//      OR the collapsible manual panel (exchange withdrawal / other wallet)
//   3. Xaman fast-path poll         -> instant "signed" / "rejected" / "expired"
//   4. /api/checkout/status poll    -> AUTHORITATIVE: matches the payment on the
//                                      ledger, marks paid, reveals the API key once

import { useCallback, useEffect, useRef, useState } from "react";
import FreeKeyFlow from "./FreeKeyFlow";
import WalletPicker from "@/lib/wallet/WalletPicker";
import {
  getProvider,
  resolveProviderOptions,
  WalletCancelled,
  type ProviderOption,
} from "@/lib/wallet";

type PayFields = {
  address: string;
  destinationTag: number;
  amount: string;
  currency: string;
  currencyHex?: string;
  issuer?: string;
  warning: string;
};

type Invoice = {
  invoiceId: string;
  plan: string;
  currency: "XRP" | "RLUSD";
  priceUsd: number;
  amount: number;
  amountXrp: number | null;
  xrpUsdRate: number | null;
  pay: PayFields;
  xamanDeeplink: string;
  xamanAvailable?: boolean;
  statusUrl: string;
};

type Currency = "XRP" | "RLUSD";
type Status = "loading" | "pending" | "paid" | "expired" | "error";
type XamanState = "idle" | "opening" | "waiting" | "signed" | "rejected" | "expired" | "error";
type ExtState = "idle" | "submitting" | "submitted" | "rejected" | "error";

export default function CheckoutFlow({ plan }: { plan: string }) {
  const [currency, setCurrency] = useState<Currency>("XRP"); // what the audience already holds
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState("");
  const [apiKey, setApiKey] = useState<string | null>(null);

  // Xaman sign-request state
  const [xaman, setXaman] = useState<XamanState>("idle");
  const [xamanMsg, setXamanMsg] = useState("");
  const [xamanQr, setXamanQr] = useState<string | null>(null);
  const [xamanLink, setXamanLink] = useState<string | null>(null);
  const xamanUuid = useRef<string | null>(null);

  // Wallet picker + injected-wallet state
  const [walletOpts, setWalletOpts] = useState<ProviderOption[]>([]);
  const [walletSel, setWalletSel] = useState<string>("xaman");
  const [ext, setExt] = useState<ExtState>("idle");
  const [extMsg, setExtMsg] = useState("");

  const isFree = plan === "free";

  // (re)create the invoice whenever plan or currency changes
  useEffect(() => {
    if (!plan || isFree) return;
    let cancelled = false;
    setStatus("loading");
    setInvoice(null);
    setError("");
    setXaman("idle");
    setXamanMsg("");
    setXamanQr(null);
    setXamanLink(null);
    xamanUuid.current = null;
    (async () => {
      try {
        const res = await fetch("/api/checkout", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ plan, currency }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(data.message ?? "Could not start checkout.");
        setInvoice(data);
        setStatus("pending");
        setExt("idle");
        setExtMsg("");
        const xamanAvailable = data.xamanAvailable !== false;
        // Show Xaman right away; extension detection resolves ~1.5s later.
        setWalletOpts([{ provider: getProvider("xaman")!, available: xamanAvailable }]);
        setWalletSel("xaman");
        resolveProviderOptions({ xamanAvailable })
          .then((opts) => {
            if (cancelled) return;
            setWalletOpts(opts);
          })
          .catch(() => {});
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Checkout failed.");
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [plan, currency, isFree]);

  // AUTHORITATIVE poll — on-ledger match, mints the key
  const poll = useCallback(async () => {
    if (!invoice) return;
    try {
      const res = await fetch(invoice.statusUrl);
      const data = await res.json();
      if (data.status === "paid") {
        setStatus("paid");
        if (data.key) setApiKey(data.key);
      } else if (data.status === "expired") {
        setStatus("expired");
      }
    } catch {
      /* keep polling */
    }
  }, [invoice]);

  useEffect(() => {
    if (status !== "pending" || !invoice) return;
    const t = setInterval(poll, 4000);
    return () => clearInterval(t);
  }, [status, invoice, poll]);

  // Xaman fast-path poll — UX feedback only ("you rejected it" / "expired")
  useEffect(() => {
    if (xaman !== "waiting" || !xamanUuid.current) return;
    const uuid = xamanUuid.current;
    const t = setInterval(async () => {
      try {
        const res = await fetch(`/api/checkout/xaman/status?uuid=${encodeURIComponent(uuid)}`);
        const data = await res.json();
        if (data.state === "signed") {
          setXaman("signed");
          setXamanMsg("Signed. Confirming on the ledger…");
        } else if (data.state === "rejected") {
          setXaman("rejected");
          setXamanMsg("You declined the request in Xaman. You can try again or pay manually.");
        } else if (data.state === "expired" || data.state === "not_found") {
          setXaman("expired");
          setXamanMsg("The sign request expired. Tap “Pay with Xaman” for a fresh one.");
        }
      } catch {
        /* on error stay in waiting — the on-ledger poll is the source of truth */
      }
    }, 3000);
    return () => clearInterval(t);
  }, [xaman]);

  const openXaman = useCallback(async () => {
    if (!invoice) return;
    setXaman("opening");
    setXamanMsg("");
    try {
      const res = await fetch("/api/checkout/xaman", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invoiceId: invoice.invoiceId }),
      });
      const data = await res.json();
      if (res.status === 429) {
        setXaman("error");
        setXamanMsg(data.message ?? "Xaman is busy — try again shortly or pay manually.");
        return;
      }
      if (!res.ok || !data.uuid) {
        setXaman("error");
        setXamanMsg(data.message ?? "Could not open Xaman. Pay manually below.");
        return;
      }
      xamanUuid.current = data.uuid;
      setXamanQr(data.qrPng ?? null);
      setXamanLink(data.deepLink ?? null);
      setXaman("waiting");
      setXamanMsg("");
      // On a phone, jump straight into Xaman with the payment pre-filled.
      if (data.deepLink && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
        window.location.href = data.deepLink;
      }
    } catch {
      setXaman("error");
      setXamanMsg("Could not reach Xaman. Pay manually below.");
    }
  }, [invoice]);

  // Injected wallet (Crossmark / GemWallet): build + submit the Payment in the
  // extension, then let the AUTHORITATIVE /api/checkout/status poll confirm it
  // on-ledger (it matches by destination tag, same as the Xaman path).
  const payWithExtension = useCallback(
    async (providerId: string) => {
      if (!invoice) return;
      const provider = getProvider(providerId);
      if (!provider) return;
      setExt("submitting");
      setExtMsg(`Approve the payment in ${provider.label}…`);
      try {
        const handle = provider.submitPayment({
          invoiceId: invoice.invoiceId,
          to: invoice.pay.address,
          amount: String(invoice.amount),
          currency: invoice.currency,
          issuer: invoice.pay.issuer ?? null,
          currencyHex: invoice.pay.currencyHex ?? null,
          destinationTag: invoice.pay.destinationTag,
        });
        await handle.result; // { via: "injected", txHash }
        setExt("submitted");
        setExtMsg("Payment sent. Confirming on the ledger…");
      } catch (e) {
        if (e instanceof WalletCancelled) {
          setExt("rejected");
          setExtMsg("You declined the payment. Try again or pay manually.");
        } else {
          setExt("error");
          setExtMsg(e instanceof Error ? e.message : "Could not submit the payment. Pay manually below.");
        }
      }
    },
    [invoice]
  );

  // ---- terminal states -----------------------------------------------------

  if (isFree) {
    return <FreeKeyFlow />;
  }

  if (status === "paid") {
    return (
      <div>
        <p style={s.p}>Payment confirmed on XRPL mainnet. Your API key:</p>
        {apiKey ? (
          <>
            <pre style={s.key}>{apiKey}</pre>
            <p style={s.warn}>Store it now — it cannot be shown again.</p>
          </>
        ) : (
          <p style={s.p}>Your key was already issued for this invoice.</p>
        )}
      </div>
    );
  }

  if (status === "expired") {
    return <p style={s.p}>This invoice timed out. Reload to start a new one.</p>;
  }

  // ---- active flow -------------------------------------------------------

  return (
    <div>
      <div style={s.toggle}>
        {(["XRP", "RLUSD"] as Currency[]).map((c) => (
          <button
            key={c}
            onClick={() => setCurrency(c)}
            style={{ ...s.toggleBtn, ...(currency === c ? s.toggleOn : {}) }}
          >
            Pay in {c}
          </button>
        ))}
      </div>

      {status === "loading" && <p style={s.polling}>Getting a quote…</p>}
      {status === "error" && <p style={s.err}>{error}</p>}

      {status === "pending" && invoice && (
        <>
          <div style={s.amountBox}>
            <div style={s.amountBig}>
              {invoice.amount} {invoice.currency}
            </div>
            {invoice.currency === "XRP" && invoice.xrpUsdRate && (
              <div style={s.amountSub}>
                ≈ ${invoice.priceUsd} at ${invoice.xrpUsdRate.toFixed(4)}/XRP · locked for 30 min
              </div>
            )}
          </div>

          {/* ---- wallet picker (Xaman default; extensions if detected) ---- */}
          {walletOpts.length > 0 && xaman !== "waiting" && ext === "idle" && (
            <WalletPicker options={walletOpts} selected={walletSel} onSelect={setWalletSel} />
          )}

          {/* ---- Xaman: one pre-filled sign request (unchanged) ---- */}
          {walletSel === "xaman" && (
            <>
              {xaman === "waiting" ? (
                <div style={s.xamanBox}>
                  <p style={s.xamanH}>Approve the payment in Xaman</p>
                  {xamanQr && <img alt="Scan with Xaman" style={s.qr} src={xamanQr} />}
                  {xamanLink && (
                    <a href={xamanLink} target="_blank" rel="noreferrer" style={s.xaman}>
                      Open in Xaman
                    </a>
                  )}
                  <p style={s.polling}>Amount, destination and tag are already filled in — just sign.</p>
                </div>
              ) : (
                <button onClick={openXaman} disabled={xaman === "opening"} style={s.xaman}>
                  {xaman === "opening" ? "Opening Xaman…" : "Pay with Xaman"}
                </button>
              )}
              {xaman === "signed" && <p style={s.okMsg}>{xamanMsg}</p>}
              {(xaman === "rejected" || xaman === "expired" || xaman === "error") && (
                <>
                  <p style={s.warn}>{xamanMsg} </p>
                  <button onClick={openXaman} style={s.retry}>Try Xaman again</button>
                </>
              )}
            </>
          )}

          {/* ---- Injected wallet (Crossmark / GemWallet) ---- */}
          {walletSel !== "xaman" && (
            <>
              {ext === "submitted" ? (
                <p style={s.okMsg}>{extMsg}</p>
              ) : (
                <button
                  onClick={() => payWithExtension(walletSel)}
                  disabled={ext === "submitting"}
                  style={s.xaman}
                >
                  {ext === "submitting"
                    ? `Opening ${getProvider(walletSel)?.label}…`
                    : `Pay with ${getProvider(walletSel)?.label}`}
                </button>
              )}
              {(ext === "rejected" || ext === "error") && (
                <>
                  <p style={s.warn}>{extMsg}</p>
                  <button onClick={() => payWithExtension(walletSel)} style={s.retry}>Try again</button>
                </>
              )}
            </>
          )}

          {/* ---- manual fallback ---- */}
          <details style={s.details}>
            <summary style={s.summary}>Pay manually (exchange withdrawal / other wallet)</summary>
            <div style={{ marginTop: 12 }}>
              <a href={invoice.xamanDeeplink} style={s.linkBtn}>Xaman deeplink</a>
              <Field label="Send to" value={invoice.pay.address} />
              <Field
                label="Destination tag (required)"
                value={String(invoice.pay.destinationTag)}
                highlight
              />
              <Field label="Amount" value={`${invoice.pay.amount} ${invoice.currency}`} />
              {invoice.currency === "RLUSD" && invoice.pay.issuer && (
                <Field label="Issuer" value={invoice.pay.issuer} />
              )}
              <p style={s.warn}>{invoice.pay.warning}</p>
            </div>
          </details>

          <p style={s.polling}>Waiting for payment… this updates itself.</p>
        </>
      )}
    </div>
  );
}

function Field({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  const copy = () => navigator.clipboard?.writeText(value).catch(() => {});
  return (
    <div style={s.field}>
      <span style={s.label}>{label}</span>
      <button onClick={copy} style={{ ...s.value, ...(highlight ? s.valueHi : {}) }} title="Tap to copy">
        {value}
      </button>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  p: { color: "#444", lineHeight: 1.5 },
  err: { color: "#b00020", marginTop: 12 },
  toggle: { display: "flex", gap: 8, marginBottom: 18 },
  toggleBtn: { flex: 1, padding: "10px 12px", borderRadius: 10, border: "1px solid #ddd", background: "#fafafa", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: "inherit" },
  toggleOn: { borderColor: "#111", background: "#111", color: "#fff" },
  amountBox: { textAlign: "center", padding: "6px 0 16px" },
  amountBig: { fontSize: 30, fontWeight: 800 },
  amountSub: { fontSize: 12, color: "#888", marginTop: 4 },
  xaman: { display: "block", width: "100%", textAlign: "center", padding: "14px 16px", borderRadius: 12, background: "#111", color: "#fff", textDecoration: "none", fontWeight: 700, border: "none", cursor: "pointer", fontSize: 15, fontFamily: "inherit" },
  retry: { display: "block", width: "100%", textAlign: "center", padding: "10px 16px", borderRadius: 10, background: "#fff", color: "#111", border: "1px solid #111", fontWeight: 700, cursor: "pointer", marginTop: 8, fontFamily: "inherit" },
  xamanBox: { border: "1px solid #e0e0e0", borderRadius: 12, padding: 16, textAlign: "center" },
  xamanH: { fontWeight: 700, margin: "0 0 10px" },
  qr: { width: 180, height: 180, margin: "0 auto 12px", display: "block" },
  okMsg: { color: "#0a7", background: "#e9fbf3", padding: "10px 12px", borderRadius: 8, fontSize: 13, marginTop: 12 },
  details: { marginTop: 16, borderTop: "1px solid #eee", paddingTop: 12 },
  summary: { cursor: "pointer", color: "#555", fontSize: 14, fontWeight: 600 },
  linkBtn: { display: "block", textAlign: "center", padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd", color: "#111", textDecoration: "none", fontWeight: 600, marginBottom: 12 },
  field: { marginBottom: 12 },
  label: { display: "block", fontSize: 13, color: "#777", marginBottom: 4 },
  value: { width: "100%", textAlign: "left", wordBreak: "break-all", fontFamily: "ui-monospace, monospace", fontSize: 14, padding: "10px 12px", borderRadius: 8, border: "1px solid #e0e0e0", background: "#fafafa", cursor: "pointer" },
  valueHi: { borderColor: "#111", background: "#fff7d6", fontWeight: 700 },
  warn: { color: "#8a6d00", background: "#fff7d6", padding: "10px 12px", borderRadius: 8, fontSize: 13, marginTop: 12 },
  polling: { textAlign: "center", color: "#888", marginTop: 16, fontSize: 14 },
  key: { background: "#111", color: "#0f0", padding: 16, borderRadius: 10, wordBreak: "break-all", whiteSpace: "pre-wrap", fontSize: 14 },
};

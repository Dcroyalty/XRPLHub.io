"use client";
// app/checkout/page.tsx
// The checkout that used to be a dead link. Reads ?plan=, creates an invoice,
// shows the manual-pay panel + Xaman deeplink, then polls until the payment
// lands and reveals the API key once.

import { useEffect, useState, useCallback } from "react";

type PayFields = {
  address: string;
  destinationTag: number;
  amount: string;
  currency: string;
  currencyHex: string;
  issuer: string;
  warning: string;
};

type Invoice = {
  invoiceId: string;
  plan: string;
  amountRlusd: number;
  pay: PayFields;
  xamanDeeplink: string;
  statusUrl: string;
};

type Status = "loading" | "pending" | "paid" | "expired" | "error";

export default function CheckoutPage() {
  const [plan, setPlan] = useState<string>("");
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [error, setError] = useState<string>("");

  // read ?plan= without extra deps
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get("plan") ?? "";
    setPlan(p);
  }, []);

  // free plan: no payment, just point them at key issuance
  useEffect(() => {
    if (plan === "free") setStatus("pending");
  }, [plan]);

  // create the invoice for a paid plan
  useEffect(() => {
    if (!plan || plan === "free") return;
    (async () => {
      try {
        const res = await fetch("/api/checkout", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ plan }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message ?? "Could not start checkout.");
        setInvoice(data);
        setStatus("pending");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Checkout failed.");
        setStatus("error");
      }
    })();
  }, [plan]);

  // poll for payment
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
    const t = setInterval(poll, 4000); // ~4s; payment usually lands in ~5s
    return () => clearInterval(t);
  }, [status, invoice, poll]);

  if (plan === "free") {
    return (
      <Shell title="Free plan">
        <p style={s.p}>
          No payment needed. Ask us for a free key, or self-issue one with your
          admin token via <code>POST /api/keys</code> using{" "}
          <code>{"{ plan: \"free\" }"}</code>.
        </p>
      </Shell>
    );
  }

  if (status === "loading") return <Shell title="Starting checkout…" />;
  if (status === "error") return <Shell title="Checkout error"><p style={s.err}>{error}</p></Shell>;
  if (status === "expired")
    return (
      <Shell title="Invoice expired">
        <p style={s.p}>This invoice timed out. Reload to start a new one.</p>
      </Shell>
    );

  if (status === "paid") {
    return (
      <Shell title="Paid ✓">
        <p style={s.p}>Payment confirmed. Here is your API key:</p>
        {apiKey ? (
          <>
            <pre style={s.key}>{apiKey}</pre>
            <p style={s.warn}>
              Store it now — it cannot be shown again.
            </p>
          </>
        ) : (
          <p style={s.p}>Your key was already issued for this invoice.</p>
        )}
      </Shell>
    );
  }

  // pending + invoice ready = show the pay panel
  if (!invoice) return <Shell title="Starting checkout…" />;
  const { pay } = invoice;
  return (
    <Shell title={`Pay ${invoice.amountRlusd.toLocaleString()} RLUSD`}>
      <a href={invoice.xamanDeeplink} style={s.xaman}>
        Open in Xaman
      </a>
      <p style={s.or}>or send manually (e.g. from an exchange):</p>
      <Field label="Send to" value={pay.address} />
      <Field label="Destination tag (required)" value={String(pay.destinationTag)} highlight />
      <Field label="Amount" value={`${pay.amount} RLUSD`} />
      <Field label="Issuer" value={pay.issuer} />
      <p style={s.warn}>{pay.warning}</p>
      <p style={s.polling}>Waiting for payment… this page updates itself.</p>
    </Shell>
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

function Shell({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <main style={s.page}>
      <h1 style={s.h1}>{title}</h1>
      {children}
    </main>
  );
}

const s: Record<string, React.CSSProperties> = {
  page: { maxWidth: 520, margin: "0 auto", padding: "48px 20px", fontFamily: "system-ui, sans-serif" },
  h1: { fontSize: 26, fontWeight: 800, marginBottom: 20 },
  p: { color: "#444", lineHeight: 1.5 },
  err: { color: "#b00020" },
  xaman: { display: "block", textAlign: "center", padding: "14px 16px", borderRadius: 12, background: "#111", color: "#fff", textDecoration: "none", fontWeight: 700 },
  or: { textAlign: "center", color: "#888", margin: "16px 0 8px", fontSize: 14 },
  field: { marginBottom: 12 },
  label: { display: "block", fontSize: 13, color: "#777", marginBottom: 4 },
  value: { width: "100%", textAlign: "left", wordBreak: "break-all", fontFamily: "ui-monospace, monospace", fontSize: 14, padding: "10px 12px", borderRadius: 8, border: "1px solid #e0e0e0", background: "#fafafa", cursor: "pointer" },
  valueHi: { borderColor: "#111", background: "#fff7d6", fontWeight: 700 },
  warn: { color: "#8a6d00", background: "#fff7d6", padding: "10px 12px", borderRadius: 8, fontSize: 13, marginTop: 12 },
  polling: { textAlign: "center", color: "#888", marginTop: 20, fontSize: 14 },
  key: { background: "#111", color: "#0f0", padding: 16, borderRadius: 10, wordBreak: "break-all", whiteSpace: "pre-wrap", fontSize: 14 },
};

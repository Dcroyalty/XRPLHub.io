"use client";
// src/components/grants/DonateBox.tsx — donate to the XRPLHub grants pool: a Xaman QR (XRP, plus RLUSD once the pool
// has an RLUSD trust line) or a card through Stripe Checkout, the donor choosing the amount either way. The
// disclosure sits right next to the buttons. XRPLHub never holds the money: Xaman pays the pool account directly.
import { useEffect, useRef, useState } from "react";
import XamanPayPrompt from "@/components/XamanPayPrompt";
import { watchXaman } from "@/lib/wallet/xamanWatch";
import { GRANTS_POOL, DONATION_DISCLOSURE } from "@/lib/grantsCopy";
import { B, S } from "@/components/brand";

type Created = { uuid: string; qr_png: string | null; deep_link: string | null; amount: string; currency: string };

export default function DonateBox({ rlusdEnabled: given }: { rlusdEnabled?: boolean }) {
  const [rlusdEnabled, setRlusd] = useState(!!given);
  const [currency, setCurrency] = useState<"XRP" | "RLUSD">(given ? "RLUSD" : "XRP");
  const [amount, setAmount] = useState("25");
  const [usd, setUsd] = useState("25");
  const [created, setCreated] = useState<Created | null>(null);
  const [state, setState] = useState<"idle" | "creating" | "waiting" | "done">("idle");
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const stopRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (given !== undefined) return;
    fetch("/api/grants/pool").then((r) => r.json()).then((j) => { const on = !!j?.rlusd?.enabled; setRlusd(on); if (on) setCurrency("RLUSD"); }).catch(() => {});
  }, [given]);
  useEffect(() => () => stopRef.current(), []);

  const donateXaman = async () => {
    setErr(""); setState("creating");
    try {
      const r = await fetch("/api/grants/donate-xaman", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amount: Number(amount), currency }) });
      const j = await r.json();
      if (!r.ok || !j.uuid) throw new Error(j.error || "Couldn't create the Xaman request.");
      setCreated(j); setState("waiting");
      const w = watchXaman(j.uuid, (res) => { if (res.signed) setState("done"); else if (res.expired) { setState("idle"); setErr("The request expired. Try again."); } else { setState("idle"); setErr("The request was declined."); } });
      stopRef.current = w.stop;
    } catch (e) {
      setState("idle"); setErr(e instanceof Error ? e.message : "Something went wrong.");
    }
  };

  const copy = async () => { try { await navigator.clipboard.writeText(GRANTS_POOL); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {} };

  return (
    <div style={{ ...S.card, padding: 16 }} id="donate">
      <div style={S.eyebrow}>Donate to the grants pool</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 14, marginTop: 10 }}>
        <div>
          <div style={{ fontWeight: 800, color: B.white, marginBottom: 8 }}>With Xaman</div>
          {state === "done" ? (
            <p style={{ margin: 0, color: B.white }}>Thank you. Your donation is on the XRP Ledger and shows on the <a href="/grants/ledger" style={{ color: B.accent }}>public donations page</a> within the hour.</p>
          ) : state === "waiting" && created ? (
            <XamanPayPrompt qrPng={created.qr_png} deepLink={created.deep_link} uuid={created.uuid} amount={created.amount} currency={created.currency} destination={GRANTS_POOL} />
          ) : (
            <>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input aria-label="Amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} style={{ ...S.input, flex: "1 1 100px" }} />
                <select aria-label="Currency" value={currency} onChange={(e) => setCurrency(e.target.value as "XRP" | "RLUSD")} style={{ ...S.input, flex: "0 0 104px" }}>
                  {rlusdEnabled && <option value="RLUSD">RLUSD</option>}
                  <option value="XRP">XRP</option>
                </select>
              </div>
              <button onClick={donateXaman} disabled={state === "creating" || !(Number(amount) > 0)} style={{ ...S.btnPrimary, width: "100%", marginTop: 8 }}>
                {state === "creating" ? "Opening Xaman…" : "Pay with Xaman"}
              </button>
              <p style={{ ...S.small, margin: "8px 0 0" }}>
                Or send any amount from any wallet to <button onClick={copy} style={{ background: "none", border: "none", padding: 0, color: B.accent, cursor: "pointer", fontFamily: "ui-monospace,monospace", fontSize: 12, wordBreak: "break-all", textAlign: "left" }}>{GRANTS_POOL}</button>{copied ? " (copied)" : ""}.
                {rlusdEnabled ? " Grants are paid in RLUSD, so RLUSD goes furthest; XRP donations are held in the pool." : " XRP only for now; RLUSD appears here once the pool has an RLUSD trust line."}
              </p>
            </>
          )}
        </div>
        <form action="/api/grants/donate-card" method="GET">
          <div style={{ fontWeight: 800, color: B.white, marginBottom: 8 }}>By card</div>
          <label style={{ position: "relative", display: "block" }}>
            <span style={{ position: "absolute", left: 12, top: 12, color: "#0b1d3f", fontWeight: 700 }}>$</span>
            <input name="amount" aria-label="Amount in US dollars" inputMode="decimal" value={usd} onChange={(e) => setUsd(e.target.value.replace(/[^0-9.]/g, ""))} style={{ ...S.input, paddingLeft: 26 }} />
          </label>
          <button type="submit" disabled={!(Number(usd) >= 5)} style={{ ...S.btnSecondary, width: "100%", marginTop: 8 }}>Donate by card</button>
          <p style={{ ...S.small, margin: "8px 0 0" }}>Secure checkout by Stripe. $5 to $10,000; you choose the amount.</p>
        </form>
      </div>
      {err && <p role="alert" style={{ color: "#fca5a5", margin: "10px 0 0", fontSize: 14 }}>{err}</p>}
      <p style={{ fontSize: 13, color: B.ink, margin: "12px 0 0", lineHeight: 1.55, borderTop: `1px solid ${B.navyLine}`, paddingTop: 10 }}>{DONATION_DISCLOSURE}</p>
    </div>
  );
}

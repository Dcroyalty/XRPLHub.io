"use client";
// src/components/ProBuy.tsx — the two ways to buy XRPLHub Pro:
//   "Buy with card"  → /api/pro/checkout → Stripe Checkout on uxus ($49/month; the key arrives on the success page)
//   "Pay with Xaman" → 49 RLUSD for 30 days. The browser makes a one-time secret and puts only its SHA-256 in the
//                      payment memo; after the payment is on the ledger, the secret claims the key
//                      (/api/pro/redeem → uxus checks the ledger). A public transaction hash alone can't claim it.
import { useEffect, useRef, useState } from "react";
import XamanPayPrompt from "@/components/XamanPayPrompt";
import { watchXaman } from "@/lib/wallet/xamanWatch";
import { B, S } from "@/components/brand";

const CLAIM_KEY = "xh_pro_claim";
const hexOf = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b as ArrayBuffer)).map((x) => x.toString(16).padStart(2, "0")).join("");

export default function ProBuy({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<"idle" | "creating" | "waiting" | "claiming" | "done" | "error">("idle");
  const [pay, setPay] = useState<{ uuid: string; qr_png: string | null; deep_link: string | null; destination: string } | null>(null);
  const [key, setKey] = useState<{ api_key: string; period_end: string } | null>(null);
  const [msg, setMsg] = useState("");
  const stopRef = useRef<() => void>(() => {});
  useEffect(() => () => stopRef.current(), []);

  const claim = async (txid: string, secret: string) => {
    setStage("claiming");
    for (let i = 0; i < 20; i++) {
      const r = await fetch("/api/pro/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ txHash: txid, secret }) }).catch(() => null);
      const j = r ? await r.json().catch(() => ({})) : {};
      if (r?.ok && j.api_key) {
        setKey({ api_key: j.api_key, period_end: j.period_end });
        setStage("done");
        try { localStorage.removeItem(CLAIM_KEY); } catch {}
        return;
      }
      if (r && (r.status === 422 || r.status === 400)) { setStage("error"); setMsg(j.message || "This payment can't be used for Pro."); return; }
      await new Promise((res) => setTimeout(res, 3000)); // not on the ledger yet / not final yet
    }
    setStage("error");
    setMsg(`Your payment went through but the key isn't ready yet. Keep this page open and try again, or email support@uxus.finance with transaction ${txid}.`);
  };

  const start = async () => {
    setOpen(true); setStage("creating"); setMsg("");
    const secretBytes = crypto.getRandomValues(new Uint8Array(32));
    const secret = hexOf(secretBytes);
    const claimHash = hexOf(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)));
    try { localStorage.setItem(CLAIM_KEY, secret); } catch {}
    const r = await fetch("/api/pro/xaman", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ claimHash }) }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    if (!r?.ok || !j.uuid) { setStage("error"); setMsg(j.error || "Couldn't open Xaman. Try card instead."); return; }
    setPay(j); setStage("waiting");
    let done = false;
    const finish = (txid: string) => { if (done) return; done = true; stopRef.current(); void claim(txid, secret); };
    const w = watchXaman(j.uuid, (res) => {
      if (res.signed && res.txid) finish(res.txid);
      else if (res.signed === false || res.expired) { done = true; setStage("error"); setMsg(res.expired ? "The request expired." : "The payment was declined."); }
    });
    // REST fallback for when the websocket misses the result.
    const poll = async () => {
      if (done) return;
      const s = await fetch(`/api/checkout/xaman/status?uuid=${j.uuid}`).then((x) => x.json()).catch(() => null);
      if (s?.state === "signed" && s.txid) finish(s.txid);
      else if (s?.state === "expired" || s?.state === "rejected") { done = true; setStage("error"); setMsg(s.state === "expired" ? "The request expired." : "The payment was declined."); }
      else if (!done) t = setTimeout(poll, w.delay());
    };
    let t = setTimeout(poll, w.delay());
    stopRef.current = () => { w.stop(); clearTimeout(t); };
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <a href="/api/pro/checkout" style={{ ...S.btnPrimary, flex: compact ? "1 1 140px" : undefined }}>Buy with card</a>
        <button onClick={start} style={{ ...S.btnSecondary, flex: compact ? "1 1 140px" : undefined }}>Pay with Xaman</button>
      </div>
      {open && (
        <div style={{ marginTop: 12, ...S.card, background: B.navyDeep }}>
          {stage === "creating" && <p style={{ margin: 0 }}>Opening Xaman…</p>}
          {stage === "waiting" && pay && (
            <>
              <p style={{ margin: "0 0 10px", color: B.white }}>49 RLUSD for 30 days of XRPLHub Pro. Keep this page open until your key appears.</p>
              <XamanPayPrompt qrPng={pay.qr_png} deepLink={pay.deep_link} uuid={pay.uuid} amount="49" currency="RLUSD" destination={pay.destination} />
            </>
          )}
          {stage === "claiming" && <p style={{ margin: 0 }}>Payment received. Getting your key from the ledger…</p>}
          {stage === "done" && key && (
            <div>
              <p style={{ margin: "0 0 6px", color: B.white, fontWeight: 800 }}>Your XRPLHub Pro key</p>
              <code style={{ display: "block", wordBreak: "break-all", background: "#fff", color: B.navy, padding: 10, borderRadius: 8, fontSize: 13 }}>{key.api_key}</code>
              <p style={{ ...S.small, margin: "8px 0 0" }}>Save it now — it is shown once. Valid until {new Date(key.period_end).toUTCString().slice(5, 16)}. Use it as <code>Authorization: Bearer …</code> on the yield and lending Pro routes and the grade APIs.</p>
            </div>
          )}
          {stage === "error" && <p role="alert" style={{ margin: 0, color: "#fca5a5" }}>{msg}</p>}
        </div>
      )}
    </div>
  );
}

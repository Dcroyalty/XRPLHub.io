"use client";
// src/components/grants/GrantApplyForm.tsx — apply for a grant (free; never a fee). After applying: the honest status
// line, an OPTIONAL updates opt-in, and links to the free wallet check and Yield Desk. No paid-product upsell here.
import { useState } from "react";
import type React from "react";
import { APPLICANT_STATUS, GRANT_CATEGORIES, GRANT_UPDATES_CONSENT } from "@/lib/grantsCopy";
import { B, S } from "@/components/brand";

export default function GrantApplyForm() {
  const [f, setF] = useState({ name: "", wallet: "", email: "", category: "", need: "", amountUsd: "50", website: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<{ id: string } | null>(null);
  const [opted, setOpted] = useState<"no" | "saving" | "yes">("no");
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      const r = await fetch("/api/grants/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...f, amountUsd: Number(f.amountUsd) }) });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || j.message || "Couldn't save your application. Try again.");
      setDone({ id: j.id });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't save your application.");
    } finally {
      setBusy(false);
    }
  };

  const optIn = async () => {
    if (!done) return;
    setOpted("saving");
    const r = await fetch("/api/grants/updates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: done.id }) }).catch(() => null);
    setOpted(r?.ok ? "yes" : "no");
  };

  if (done) {
    return (
      <div style={S.card}>
        <div style={S.eyebrow}>Application saved</div>
        <p style={{ color: B.white, fontSize: 17, margin: "8px 0 12px", lineHeight: 1.5 }}>{APPLICANT_STATUS}</p>
        <div style={{ borderTop: `1px solid ${B.navyLine}`, paddingTop: 12 }}>
          {opted === "yes" ? (
            <p style={{ margin: 0, color: B.ink }}>You&apos;re signed up for updates. Unsubscribe any time from any email.</p>
          ) : (
            <>
              <p style={{ margin: "0 0 8px", color: B.ink, fontSize: 14 }}>Optional: {GRANT_UPDATES_CONSENT}</p>
              <button onClick={optIn} disabled={opted === "saving"} style={S.btnSecondary}>{opted === "saving" ? "Saving…" : "Yes, email me updates"}</button>
            </>
          )}
        </div>
        <div style={{ borderTop: `1px solid ${B.navyLine}`, marginTop: 12, paddingTop: 12 }}>
          <p style={{ margin: "0 0 8px", color: B.ink, fontSize: 14 }}>While you wait, two free tools:</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <a href="/#check" style={S.btnSecondary}>Free wallet check</a>
            <a href="/yield" style={S.btnSecondary}>Yield Desk ratings</a>
          </div>
        </div>
      </div>
    );
  }

  const label: React.CSSProperties = { display: "block", fontSize: 13, fontWeight: 700, color: B.white, margin: "10px 0 5px" };
  return (
    <form onSubmit={submit} style={S.card} id="apply">
      <div style={S.eyebrow}>Apply — free, never a fee</div>
      <label style={label} htmlFor="g-wallet">Your XRP wallet address</label>
      <input id="g-wallet" required value={f.wallet} onChange={set("wallet")} placeholder="r…" autoComplete="off" spellCheck={false} style={S.input} />
      <label style={label} htmlFor="g-email">Email (we tell you when review starts)</label>
      <input id="g-email" type="email" required value={f.email} onChange={set("email")} autoComplete="email" inputMode="email" style={S.input} />
      <label style={label} htmlFor="g-name">Name (optional)</label>
      <input id="g-name" value={f.name} onChange={set("name")} autoComplete="name" style={S.input} />
      <label style={label} htmlFor="g-cat">What is it for?</label>
      <select id="g-cat" required value={f.category} onChange={set("category")} style={S.input}>
        <option value="">Choose one</option>
        {GRANT_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <label style={label} htmlFor="g-need">Tell us what you need</label>
      <textarea id="g-need" required minLength={20} maxLength={2000} rows={4} value={f.need} onChange={set("need")} style={{ ...S.input, resize: "vertical" }} />
      <label style={label} htmlFor="g-amt">Amount ($10 to $100, paid in RLUSD)</label>
      <input id="g-amt" required inputMode="numeric" value={f.amountUsd} onChange={set("amountUsd")} style={S.input} />
      <p style={{ ...S.small, margin: "6px 0 0" }}>Grants are paid in RLUSD, a US-dollar stablecoin. Your wallet needs an RLUSD trust line to receive it; we'll tell you how if it doesn't have one.</p>
      <input tabIndex={-1} aria-hidden="true" autoComplete="off" name="website" value={f.website} onChange={set("website")} style={{ position: "absolute", left: -9999, width: 1, height: 1, opacity: 0 }} />
      {err && <p role="alert" style={{ color: "#fca5a5", margin: "10px 0 0", fontSize: 14 }}>{err}</p>}
      <button type="submit" disabled={busy} style={{ ...S.btnPrimary, width: "100%", marginTop: 14 }}>{busy ? "Saving…" : "Submit application"}</button>
      <p style={{ ...S.small, margin: "8px 0 0" }}>{APPLICANT_STATUS} We use your email only for this application unless you opt in to updates afterwards. <a href="/privacy" style={{ color: B.accent }}>Privacy</a>.</p>
    </form>
  );
}

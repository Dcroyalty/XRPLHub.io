"use client";
// src/app/grants/status/page.tsx — check a grant application by wallet address: Pending, Approved, Paid or Denied.
// While pending or approved, the applicant can propose a destination tag (exchange accounts need one) or a different
// wallet. Proposals are confirmed by XRPLHub before any payment (src/app/api/grants/status/route.ts).
import { useState } from "react";
import type React from "react";
import SiteNav from "@/components/SiteNav";
import { B, S } from "@/components/brand";

type App = {
  id: string; status: string; amountUsd: number; appliedAt: string; paidAt: string | null;
  payout: { address: string; destinationTag: number | null; ready: boolean | null; note: string | null };
  proposed: { address: string | null; destinationTag: number | null; at: string } | null;
  canEditPayout: boolean;
  deniedNote: string | null;
};

const day = (d: string) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

function PayoutForm({ wallet, app, onSaved }: { wallet: string; app: App; onSaved: () => void }) {
  const [tag, setTag] = useState("");
  const [other, setOther] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setMsg(null);
    const r = await fetch("/api/grants/status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet, id: app.id, destinationTag: tag.trim(), payoutWallet: other.trim() }) }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    setBusy(false);
    setMsg({ ok: !!r?.ok, text: j.message || j.error || "Couldn't save. Try again." });
    if (r?.ok) onSaved();
  };
  return (
    <form onSubmit={save} style={{ marginTop: 10, borderTop: `1px solid ${B.navyLine}`, paddingTop: 10 }}>
      <p style={{ margin: "0 0 8px", fontSize: 14 }}>Add payout details. If your wallet is an exchange account, add its <strong style={{ color: B.white }}>destination tag</strong> (sometimes called memo). Or give a personal wallet that can hold RLUSD.</p>
      <div style={{ display: "grid", gap: 8 }}>
        <input value={tag} onChange={(e) => setTag(e.target.value.replace(/[^0-9]/g, ""))} inputMode="numeric" placeholder="Destination tag (numbers only)" aria-label="Destination tag" style={S.input} />
        <input value={other} onChange={(e) => setOther(e.target.value.trim())} placeholder="Or a different wallet (r…)" aria-label="Different wallet" spellCheck={false} autoComplete="off" style={S.input} />
        <button type="submit" disabled={busy || (!tag && !other)} style={S.btnPrimary}>{busy ? "Saving…" : "Save payout details"}</button>
      </div>
      {msg && <p role="status" style={{ margin: "8px 0 0", color: msg.ok ? B.white : "#fca5a5", fontSize: 14 }}>{msg.text}</p>}
    </form>
  );
}

export default function GrantStatusPage() {
  const [wallet, setWallet] = useState("");
  const [apps, setApps] = useState<App[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const look = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy(true); setErr("");
    const r = await fetch(`/api/grants/status?wallet=${encodeURIComponent(wallet.trim())}`).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    setBusy(false);
    if (!r?.ok) { setErr(j.error || "Couldn't look that up. Try again."); setApps(null); return; }
    setApps(j.applications ?? []);
  };
  return (
    <div style={{ minHeight: "100vh", fontFamily: B.sans, color: B.ink }}>
      <SiteNav active="grants" />
      <main style={{ maxWidth: 720, margin: "0 auto", padding: "22px 16px 60px" }}>
        <div style={S.eyebrow}>Community grants</div>
        <h1 style={{ fontFamily: B.serif, fontSize: "clamp(28px,6.5vw,40px)", color: B.white, margin: "6px 0 10px" }}>Check your application</h1>
        <form onSubmit={look} style={{ ...S.card, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input value={wallet} onChange={(e) => setWallet(e.target.value)} placeholder="Your XRP wallet address (r…)" aria-label="Wallet address" spellCheck={false} autoComplete="off" style={{ ...S.input, flex: "1 1 220px" }} />
          <button type="submit" disabled={busy} style={S.btnPrimary}>{busy ? "Checking…" : "Check status"}</button>
        </form>
        {err && <p role="alert" style={{ color: "#fca5a5" }}>{err}</p>}
        {apps && apps.length === 0 && <div style={{ ...S.card, marginTop: 12 }}>No application for that wallet. <a href="/grants#apply" style={{ color: B.accent }}>Apply here</a> — it&apos;s free.</div>}
        {apps?.map((a) => (
          <section key={a.id} style={{ ...S.card, marginTop: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
              <strong style={{ color: B.white, fontSize: 20, fontFamily: B.serif }}>{a.status}</strong>
              <span style={{ color: B.accent, fontWeight: 800 }}>${a.amountUsd} in RLUSD</span>
            </div>
            <p style={{ ...S.small, margin: "4px 0 0" }}>Applied {day(a.appliedAt)}{a.paidAt ? ` · paid ${day(a.paidAt)}` : ""}</p>
            {a.deniedNote && <p style={{ margin: "8px 0 0", fontSize: 15, color: B.white }}>{a.deniedNote} <a href="/grants#apply" style={{ color: B.accent }}>Apply again</a></p>}
            {a.status === "Pending" && <p style={{ margin: "8px 0 0", fontSize: 14 }}>Applications are reviewed in order once the pool reaches its first milestone. Grants are paid at XRPLHub&apos;s discretion when the pool has funds.</p>}
            {a.canEditPayout && (
              <p style={{ margin: "8px 0 0", fontSize: 14 }}>
                Pays to {a.payout.address.slice(0, 8)}…{a.payout.address.slice(-4)}{a.payout.destinationTag != null ? `, tag ${a.payout.destinationTag}` : ""}.{" "}
                {a.payout.ready === true ? <span style={{ color: B.white }}>Ready to receive RLUSD.</span> : a.payout.note ? <strong style={{ color: B.accent }}>{a.payout.note.replace(/^needs payout details: /, "Needs payout details: ")}.</strong> : null}
              </p>
            )}
            {a.proposed && <p style={{ ...S.small, margin: "6px 0 0" }}>New payout details received {day(a.proposed.at)}; we&apos;ll confirm them before paying.</p>}
            {a.canEditPayout && <PayoutForm wallet={wallet.trim()} app={a} onSaved={() => look()} />}
          </section>
        ))}
        <p style={{ ...S.small, marginTop: 16 }}>We never ask for a fee, your keys or your seed. Anyone who does is not us.</p>
      </main>
    </div>
  );
}

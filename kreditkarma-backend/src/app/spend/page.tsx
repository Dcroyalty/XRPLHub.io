"use client";
// src/app/spend/page.tsx — Spend Controls: what it is, and the create-a-plan form with a live preview
// (the check split, the XRP reserve that locks up front, and whether the funder's wallet covers a period).
// Two kinds: a BUDGET (approved payees, a budget each, RLUSD) or a SUBSCRIPTION (one payee, one check per period,
// RLUSD or XRP — created only when each period starts, never ahead).

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { API, Disclosure, s, useXapp } from "./ui";

type Payee = { address: string; label: string; category: string; budget: string; destinationTag: string };
const CATEGORIES = ["food", "groceries", "clothing", "school", "transport", "health", "housing", "utilities", "entertainment", "other"];
const blank = (): Payee => ({ address: "", label: "", category: "food", budget: "", destinationTag: "" });

type Preview = {
  checksPerPeriod: number; totalPerPeriod: string; checkSize: string;
  payees: { label: string; budget: string; checks: string[] }[];
  reserve: { perCheckXrp: number; upFrontXrp: number; note: string };
  fundingNote: string; funded: boolean | null;
  payeeProblems: { payee: number; label: string; error: string }[];
  disclosure: string[];
};

export default function SpendPage() {
  const [kind, setKind] = useState<"budget" | "subscription">(() => (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("kind") === "subscription" ? "subscription" : "budget"));
  const [currency, setCurrency] = useState<"RLUSD" | "XRP">("RLUSD");
  const [funder, setFunder] = useState("");
  // Inside the Xaman xApp the funder IS the account Xaman confirmed — prefilled and locked.
  const xapp = useXapp();
  useEffect(() => { if (xapp) setFunder(xapp.account); }, [xapp]); // eslint-disable-line react-hooks/set-state-in-effect
  const [name, setName] = useState("");
  const [period, setPeriod] = useState<"weekly" | "monthly">("weekly");
  const [checkSize, setCheckSize] = useState("10");
  const [payees, setPayees] = useState<Payee[]>([blank()]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const sub = kind === "subscription";
  const cur = sub ? currency : "RLUSD";
  const body = () => ({
    kind, currency: cur, funder: funder.trim(), name, period, ...(sub ? {} : { checkSize }),
    payees: (sub ? payees.slice(0, 1) : payees).map((p) => ({ ...p, destinationTag: p.destinationTag.trim() === "" ? null : Number(p.destinationTag) })),
  });

  // Live preview, debounced: the server validates and reads the ledger (reserve, payee accounts, funder balance).
  useEffect(() => {
    const t = setTimeout(async () => {
      if (!funder.trim() || payees.every((p) => !p.address)) { setPreview(null); return; }
      try {
        const r = await fetch(`${API}/api/spend/plans?dryRun=1`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body()) });
        const d = await r.json();
        if (r.ok) { setPreview(d.preview); setError(""); } else { setPreview(d.preview ?? null); setError(d.message ?? "Check the form."); }
      } catch { /* keep the last preview */ }
    }, 700);
    return () => clearTimeout(t);
  }, [kind, currency, funder, name, period, checkSize, payees]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    setBusy(true); setError("");
    try {
      const r = await fetch(`${API}/api/spend/plans`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body()) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message ?? "Could not create the plan");
      window.location.href = d.dashboard;
    } catch (e) { setError(e instanceof Error ? e.message : "Could not create the plan"); setBusy(false); }
  };

  const setP = (i: number, k: keyof Payee, v: string) => setPayees((ps) => ps.map((p, j) => (j === i ? { ...p, [k]: v } : p)));

  return (
    <div style={s.shell}>
      <main style={s.page}>
        {xapp ? <a href="/xapp/spend" style={s.small}>← My plans</a> : <Link href="/" style={s.small}>← XRPLHub</Link>}
        <h1 style={s.h1}>Spend Controls</h1>
        <p style={s.sub}>
          A spending plan for someone you support — only at places you approve, up to amounts you set, paid by XRPL checks in RLUSD.
          You sign every check in your own wallet; the merchant cashes it in theirs. Free — no plan fee, no prepay; merchants cash free.
        </p>
        <Disclosure lines={preview?.disclosure ?? [
          "XRPLHub is not a bank and not a money transmitter. It never holds your funds or your keys.",
          "You sign everything: the funder signs each check, and the merchant signs to cash it, each in their own wallet.",
          "Checks do not lock funds. Keep your allowance in your wallet — a check can only be cashed while the money is there.",
          "RLUSD can't be held in escrow yet (its issuer hasn't enabled token escrow), which is why this uses checks.",
        ]} />

        <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
          {(["budget", "subscription"] as const).map((k) => (
            <button key={k} type="button" onClick={() => setKind(k)} style={kind === k ? s.btn : s.btnGhost}>
              {k === "budget" ? "Budget — approved places, a limit each" : "Subscription — pay one payee every period"}
            </button>
          ))}
        </div>
        {sub && (
          <div style={{ ...s.card, background: "#eef8f6", borderColor: "#99d5cc" }}>
            <p style={{ ...s.h2, fontSize: 14 }}>How subscriptions work</p>
            <p style={{ ...s.small, color: "#334" }}>One check per period for the amount you set. A check can be cashed as soon as it exists, so the next period&apos;s check is never created early: when a new period starts we send its sign request to your Xaman app (after your first signature). Until you sign it, that period is unpaid. Stop any time — just don&apos;t sign, or cancel an open check before it&apos;s cashed.</p>
          </div>
        )}

        <div style={s.card}>
          <p style={s.h2}>1. The {sub ? "subscription" : "plan"}</p>
          <label style={s.label}>Your XRPL account (the funder — you&apos;ll sign the checks from it)</label>
          <input style={{ ...s.input, ...s.mono, ...(xapp ? { background: "#f4f4f2" } : {}) }} value={funder} readOnly={!!xapp} onChange={(e) => setFunder(e.target.value)} placeholder="r…" />
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
            <div style={{ flex: "1 1 180px" }}><label style={s.label}>Name (optional)</label><input style={s.input} value={name} onChange={(e) => setName(e.target.value)} placeholder={sub ? "Gym membership" : "Sam's allowance"} /></div>
            <div style={{ flex: "1 1 120px" }}><label style={s.label}>Period</label>
              <select style={s.input} value={period} onChange={(e) => setPeriod(e.target.value as "weekly" | "monthly")}><option value="weekly">Weekly (Mon–Sun, UTC)</option><option value="monthly">Monthly (calendar, UTC)</option></select></div>
            {sub
              ? <div style={{ flex: "1 1 120px" }}><label style={s.label}>Currency</label><select style={s.input} value={currency} onChange={(e) => setCurrency(e.target.value as "RLUSD" | "XRP")}><option value="RLUSD">RLUSD</option><option value="XRP">XRP</option></select></div>
              : <div style={{ flex: "1 1 120px" }}><label style={s.label}>Check size (RLUSD)</label><input style={s.input} value={checkSize} onChange={(e) => setCheckSize(e.target.value)} inputMode="decimal" /></div>}
          </div>
          {!sub && <p style={{ ...s.small, marginTop: 6 }}>Each payee&apos;s budget is split into checks of this size, so a merchant can be paid several times a period. A check pays once.</p>}
        </div>

        <div style={s.card}>
          <p style={s.h2}>{sub ? "2. Who you pay" : "2. Approved payees (up to 10)"}</p>
          {(sub ? payees.slice(0, 1) : payees).map((p, i) => (
            <div key={i} style={{ borderTop: i ? "1px solid #eee" : "none", paddingTop: i ? 10 : 0, marginTop: i ? 10 : 0 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <div style={{ flex: "2 1 220px" }}><label style={s.label}>Merchant&apos;s XRPL address</label><input style={{ ...s.input, ...s.mono }} value={p.address} onChange={(e) => setP(i, "address", e.target.value)} placeholder="r…" /></div>
                <div style={{ flex: "1 1 140px" }}><label style={s.label}>Name</label><input style={s.input} value={p.label} onChange={(e) => setP(i, "label", e.target.value)} placeholder="Joe's Market" /></div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                <div style={{ flex: "1 1 120px" }}><label style={s.label}>Category</label><select style={s.input} value={p.category} onChange={(e) => setP(i, "category", e.target.value)}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></div>
                <div style={{ flex: "1 1 120px" }}><label style={s.label}>{sub ? `Amount per period (${cur})` : "Budget per period (RLUSD)"}</label><input style={s.input} value={p.budget} onChange={(e) => setP(i, "budget", e.target.value)} inputMode="decimal" placeholder="50" /></div>
                <div style={{ flex: "1 1 120px" }}><label style={s.label}>Destination tag (if required)</label><input style={s.input} value={p.destinationTag} onChange={(e) => setP(i, "destinationTag", e.target.value)} inputMode="numeric" /></div>
              </div>
              {!sub && payees.length > 1 && <button type="button" style={{ ...s.btnGhost, marginTop: 6 }} onClick={() => setPayees((ps) => ps.filter((_, j) => j !== i))}>Remove</button>}
              {preview?.payeeProblems?.filter((x) => x.payee === i).map((x) => <p key={x.error} style={s.err}>{x.error}</p>)}
            </div>
          ))}
          {!sub && payees.length < 10 && <button type="button" style={{ ...s.btnGhost, marginTop: 10 }} onClick={() => setPayees((ps) => [...ps, blank()])}>+ Add a payee</button>}
        </div>

        {preview && (
          <div style={s.card}>
            <p style={s.h2}>3. What this creates each {period === "weekly" ? "week" : "month"}</p>
            <table style={s.table}><tbody>
              {preview.payees.map((p) => <tr key={p.label}><td style={s.td}>{p.label}</td><td style={s.td}>{p.budget} {cur}</td><td style={s.td}>{p.checks.length} check{p.checks.length === 1 ? "" : "s"}: {p.checks.join(" + ")}</td></tr>)}
            </tbody></table>
            <p style={{ marginTop: 10, fontSize: 14 }}><strong>{preview.checksPerPeriod} check{preview.checksPerPeriod === 1 ? "" : "s"}, {preview.totalPerPeriod} {cur} per period.</strong></p>
            <p style={{ fontSize: 14, margin: "6px 0" }}><strong>XRP reserve that locks up front: {preview.reserve.upFrontXrp} XRP</strong> ({preview.reserve.perCheckXrp} XRP per open check). {preview.reserve.note}</p>
            <p style={preview.funded === false ? s.err : s.small}>{preview.fundingNote}</p>
            <p style={s.small}>{sub ? "Free — no fee. One signature per period, in your own wallet." : "Free — no plan fee. One signature per check (one signature for all of them once the XRPL Batch amendment is live and verified in Xaman)."}</p>
          </div>
        )}
        {error && <p style={s.err}>{error}</p>}
        <button type="button" style={{ ...s.btn, opacity: busy || !preview || preview.payeeProblems.length ? 0.5 : 1 }} disabled={busy || !preview || !!preview.payeeProblems.length} onClick={create}>
          {busy ? "Creating…" : sub ? "Create the subscription →" : "Create the plan →"}
        </button>
        <p style={{ ...s.small, marginTop: 8 }}>Next you sign the checks from this account — no payment to XRPLHub.</p>
      </main>
    </div>
  );
}

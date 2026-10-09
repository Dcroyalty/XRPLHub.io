"use client";
// src/app/spend/page.tsx — Spend Controls: what it is, and the create-a-plan form with a live preview
// (the check split, the XRP reserve that locks up front, and whether the funder's wallet covers a period).
// Two kinds: a BUDGET (approved payees, a budget each, RLUSD) or a SUBSCRIPTION (one payee, one check per period,
// RLUSD or XRP — created only when each period starts, never ahead).

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { API, ConnectXaman, Disclosure, s, useSignedInWallet, useXapp } from "./ui";

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
  // The funder is the wallet you signed in with (Xaman SignIn on the web, or the xApp account) — prefilled and locked.
  const xapp = useXapp();
  const [wallet, setWallet] = useSignedInWallet();
  useEffect(() => { if (wallet) setFunder(wallet); }, [wallet]); // eslint-disable-line react-hooks/set-state-in-effect
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
          Give money with rules. An allowance someone can only spend at places you pick, up to amounts you set, paid in RLUSD (a digital US dollar).
          Or pay one bill every week or month in XRP or RLUSD. You approve every payment in your own wallet. Free: no fee, nothing to pay up front.
        </p>
        <Disclosure lines={preview?.disclosure ?? [
          "XRPLHub is not a bank and doesn't send money for you. We never hold your money or your keys.",
          "You approve everything in your own wallet: you approve each check, and the person being paid approves cashing it.",
          "A check doesn't set money aside. Keep enough in your wallet — a check can only be cashed while the money is there.",
          "We use checks because RLUSD can't be locked up in advance on the XRP Ledger yet.",
        ]} />

        <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
          {(["budget", "subscription"] as const).map((k) => (
            <button key={k} type="button" onClick={() => setKind(k)} style={kind === k ? s.btn : s.btnGhost}>
              {k === "budget" ? "Allowance — places you pick, a limit for each" : "Recurring payment — pay one bill every week or month"}
            </button>
          ))}
        </div>
        {sub && (
          <div style={{ ...s.card, background: "#eef8f6", borderColor: "#99d5cc" }}>
            <p style={{ ...s.h2, fontSize: 14 }}>How recurring payments work</p>
            <p style={{ ...s.small, color: "#334" }}>One check each week or month for the amount you set. A check can be cashed as soon as it exists, so we never make next month&apos;s early. When a new week or month starts, we send that payment to your Xaman app to approve (after you approve the first one). Until you approve it, that period isn&apos;t paid. Stop anytime: just don&apos;t approve it, or cancel a check before it&apos;s cashed. Tired of approving every month? Turn on Autopay on your dashboard after you set this up: approve the next payments at once, and we send one at the start of each period.</p>
          </div>
        )}

        <ConnectXaman wallet={wallet} onChange={(w) => { setWallet(w); if (!w) setFunder(""); }} purpose="you pay from it" />

        <div style={s.card}>
          <p style={s.h2}>1. The {sub ? "payment" : "allowance"}</p>
          <label style={s.label}>Your XRP wallet address (you&apos;ll pay from it and approve each check there)</label>
          <input style={{ ...s.input, ...s.mono, ...(wallet ? { background: "#f4f4f2" } : {}) }} value={funder} readOnly={!!wallet} onChange={(e) => setFunder(e.target.value)} placeholder={wallet === "" ? "Sign in with Xaman above, or type it (Crossmark / GemWallet)" : "r…"} />
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
            <div style={{ flex: "1 1 180px" }}><label style={s.label}>Name (optional)</label><input style={s.input} value={name} onChange={(e) => setName(e.target.value)} placeholder={sub ? "Gym membership" : "Sam's allowance"} /></div>
            <div style={{ flex: "1 1 120px" }}><label style={s.label}>How often</label>
              <select style={s.input} value={period} onChange={(e) => setPeriod(e.target.value as "weekly" | "monthly")}><option value="weekly">Every week (Mon–Sun, UTC time)</option><option value="monthly">Every month (UTC time)</option></select></div>
            {sub
              ? <div style={{ flex: "1 1 120px" }}><label style={s.label}>Currency</label><select style={s.input} value={currency} onChange={(e) => setCurrency(e.target.value as "RLUSD" | "XRP")}><option value="RLUSD">RLUSD</option><option value="XRP">XRP</option></select></div>
              : <div style={{ flex: "1 1 120px" }}><label style={s.label}>Size of each check (RLUSD)</label><input style={s.input} value={checkSize} onChange={(e) => setCheckSize(e.target.value)} inputMode="decimal" /></div>}
          </div>
          {!sub && <p style={{ ...s.small, marginTop: 6 }}>Each place&apos;s limit is split into checks of this size, so it can be paid several times a week or month. Each check can be used once.</p>}
        </div>

        <div style={s.card}>
          <p style={s.h2}>{sub ? "2. Who you pay" : "2. Places they can spend (up to 10)"}</p>
          {(sub ? payees.slice(0, 1) : payees).map((p, i) => (
            <div key={i} style={{ borderTop: i ? "1px solid #eee" : "none", paddingTop: i ? 10 : 0, marginTop: i ? 10 : 0 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <div style={{ flex: "2 1 220px" }}><label style={s.label}>Their XRP wallet address</label><input style={{ ...s.input, ...s.mono }} value={p.address} onChange={(e) => setP(i, "address", e.target.value)} placeholder="r…" /></div>
                <div style={{ flex: "1 1 140px" }}><label style={s.label}>Name</label><input style={s.input} value={p.label} onChange={(e) => setP(i, "label", e.target.value)} placeholder="Joe's Market" /></div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                <div style={{ flex: "1 1 120px" }}><label style={s.label}>Category</label><select style={s.input} value={p.category} onChange={(e) => setP(i, "category", e.target.value)}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></div>
                <div style={{ flex: "1 1 120px" }}><label style={s.label}>{sub ? `Amount each time (${cur})` : "Limit each week or month (RLUSD)"}</label><input style={s.input} value={p.budget} onChange={(e) => setP(i, "budget", e.target.value)} inputMode="decimal" placeholder="50" /></div>
                <div style={{ flex: "1 1 120px" }}><label style={s.label}>Destination tag (only if they gave you one)</label><input style={s.input} value={p.destinationTag} onChange={(e) => setP(i, "destinationTag", e.target.value)} inputMode="numeric" /></div>
              </div>
              {!sub && payees.length > 1 && <button type="button" style={{ ...s.btnGhost, marginTop: 6 }} onClick={() => setPayees((ps) => ps.filter((_, j) => j !== i))}>Remove</button>}
              {preview?.payeeProblems?.filter((x) => x.payee === i).map((x) => <p key={x.error} style={s.err}>{x.error}</p>)}
            </div>
          ))}
          {!sub && payees.length < 10 && <button type="button" style={{ ...s.btnGhost, marginTop: 10 }} onClick={() => setPayees((ps) => [...ps, blank()])}>+ Add a place</button>}
        </div>

        {preview && (
          <div style={s.card}>
            <p style={s.h2}>3. What this creates each {period === "weekly" ? "week" : "month"}</p>
            <table style={s.table}><tbody>
              {preview.payees.map((p) => <tr key={p.label}><td style={s.td}>{p.label}</td><td style={s.td}>{p.budget} {cur}</td><td style={s.td}>{p.checks.length} check{p.checks.length === 1 ? "" : "s"}: {p.checks.join(" + ")}</td></tr>)}
            </tbody></table>
            <p style={{ marginTop: 10, fontSize: 14 }}><strong>{preview.checksPerPeriod} check{preview.checksPerPeriod === 1 ? "" : "s"}, {preview.totalPerPeriod} {cur} per period.</strong></p>
            <p style={{ fontSize: 14, margin: "6px 0" }}><strong>XRP set aside in your wallet while checks are open: {preview.reserve.upFrontXrp} XRP</strong> ({preview.reserve.perCheckXrp} XRP per open check). {preview.reserve.note}</p>
            <p style={preview.funded === false ? s.err : s.small}>{preview.fundingNote}</p>
            <p style={s.small}>{sub ? "Free, no fee. You approve once each week or month, in your own wallet." : "Free, no fee. You approve each check in your own wallet (later, one approval may cover them all)."}</p>
          </div>
        )}
        {error && <p style={s.err}>{error}</p>}
        <button type="button" style={{ ...s.btn, opacity: busy || !preview || preview.payeeProblems.length ? 0.5 : 1 }} disabled={busy || !preview || !!preview.payeeProblems.length} onClick={create}>
          {busy ? "Creating…" : sub ? "Set up the payment →" : "Set up the allowance →"}
        </button>
        <p style={{ ...s.small, marginTop: 8 }}>Next you approve the checks in your wallet. You never pay XRPLHub.</p>
      </main>
    </div>
  );
}

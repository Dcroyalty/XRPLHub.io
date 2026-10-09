"use client";
// src/app/send-many/page.tsx — BATCH SEND for people: "pay up to 8 people with one approval — everyone or no one."
// Free. POST /api/batch-send checks every payment on the live ledger, then returns one all-or-nothing Batch to approve.

import React, { useState } from "react";
import Link from "next/link";
import { API, Disclosure, SignPanel, s, type SignData } from "../spend/ui";

type Row = { address: string; amount: string; currency: "XRP" | "RLUSD"; destinationTag: string; label: string };
type Problem = { index: number; address: string; error: string };
const blank = (): Row => ({ address: "", amount: "", currency: "XRP", destinationTag: "", label: "" });

export default function SendManyPage() {
  const [from, setFrom] = useState("");
  const [rows, setRows] = useState<Row[]>([blank(), blank()]);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState<{ data: SignData; title: string; feeXrp: number } | null>(null);
  const [done, setDone] = useState(false);

  const set = (i: number, k: keyof Row, v: string) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const prepare = async () => {
    setBusy(true); setErr(""); setProblems([]); setReady(null); setDone(false);
    try {
      const res = await fetch(`${API}/api/batch-send`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: from.trim(), recipients: rows.map((r) => ({ address: r.address.trim(), amount: r.amount.trim(), currency: r.currency, destinationTag: r.destinationTag.trim() === "" ? null : Number(r.destinationTag), label: r.label })) }),
      });
      const j = await res.json();
      if (!res.ok) { setErr(j.message ?? "Something went wrong."); setProblems(j.problems ?? []); return; }
      const t = [j.totals.xrp ? `${j.totals.xrp} XRP` : "", j.totals.rlusd ? `${j.totals.rlusd} RLUSD` : ""].filter(Boolean).join(" + ");
      setReady({ data: j, title: `Approve: pay ${j.payments} people ${t} at once`, feeXrp: j.networkFeeXrp });
    } catch { setErr("Something went wrong. Try again."); }
    finally { setBusy(false); }
  };
  const total = (c: "XRP" | "RLUSD") => rows.filter((r) => r.currency === c).reduce((a, r) => a + (Number(r.amount) || 0), 0);

  return (
    <div style={s.shell}>
      <main style={s.page}>
        <Link href="/" style={s.small}>← XRPLHub</Link>
        <h1 style={s.h1}>Pay up to 8 people with one approval</h1>
        <p style={s.sub}>
          Send XRP or RLUSD (a digital US dollar) to several people at once. You approve it once in your own wallet. Either
          everyone gets paid, or nobody does — never half. Free. We check every payment first and tell you if one can&apos;t go through.
        </p>

        <div style={s.card}>
          <label style={s.label}>Your XRP wallet address (you pay from it)</label>
          <input style={{ ...s.input, ...s.mono }} value={from} onChange={(e) => setFrom(e.target.value)} placeholder="r…" />
        </div>

        <div style={s.card}>
          <p style={s.h2}>Who you pay ({rows.length} of 8)</p>
          {rows.map((r, i) => {
            const p = problems.find((x) => x.index === i);
            return (
              <div key={i} style={{ borderTop: i ? "1px solid #eee" : "none", paddingTop: i ? 10 : 0, marginTop: i ? 10 : 0 }}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <div style={{ flex: "2 1 220px" }}><label style={s.label}>Their XRP wallet address</label><input style={{ ...s.input, ...s.mono }} value={r.address} onChange={(e) => set(i, "address", e.target.value)} placeholder="r…" /></div>
                  <div style={{ flex: "1 1 120px" }}><label style={s.label}>Name (just for you)</label><input style={s.input} value={r.label} onChange={(e) => set(i, "label", e.target.value)} placeholder="Sam" /></div>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                  <div style={{ flex: "1 1 100px" }}><label style={s.label}>Amount</label><input style={s.input} value={r.amount} onChange={(e) => set(i, "amount", e.target.value)} inputMode="decimal" placeholder="10" /></div>
                  <div style={{ flex: "1 1 100px" }}><label style={s.label}>Currency</label><select style={s.input} value={r.currency} onChange={(e) => set(i, "currency", e.target.value)}><option>XRP</option><option>RLUSD</option></select></div>
                  <div style={{ flex: "1 1 120px" }}><label style={s.label}>Destination tag (only if they gave you one)</label><input style={s.input} value={r.destinationTag} onChange={(e) => set(i, "destinationTag", e.target.value)} inputMode="numeric" /></div>
                </div>
                {p && <p style={s.err}>{p.error}</p>}
                {rows.length > 2 && <button type="button" style={{ ...s.btnGhost, marginTop: 6 }} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>Remove</button>}
              </div>
            );
          })}
          {rows.length < 8 && <button type="button" style={{ ...s.btnGhost, marginTop: 10 }} onClick={() => setRows((rs) => [...rs, blank()])}>+ Add a person</button>}
          <p style={{ ...s.small, marginTop: 10 }}>Total: {[total("XRP") ? `${total("XRP")} XRP` : "", total("RLUSD") ? `${total("RLUSD")} RLUSD` : ""].filter(Boolean).join(" + ") || "—"}</p>
        </div>

        {problems.filter((p) => p.index < 0).map((p) => <p key={p.error} style={s.err}>{p.error}</p>)}
        {err && <p style={s.err}>{err}</p>}
        <button type="button" style={{ ...s.btn, opacity: busy ? 0.5 : 1 }} disabled={busy} onClick={prepare}>{busy ? "Checking every payment…" : "Check and prepare →"}</button>

        {ready && (
          <div style={{ marginTop: 14 }}>
            <SignPanel data={ready.data} title={ready.title} onSigned={() => setDone(true)} onDone={() => setReady(null)} />
            <p style={s.small}>Network fee for the whole batch: {ready.feeXrp} XRP. Approve it before sending anything else from this wallet — otherwise the XRP Ledger refuses it and nobody is paid.</p>
          </div>
        )}
        {done && <p style={s.ok}>Approved. If every payment could go through, all of them are paid now. Check your wallet&apos;s history to confirm.</p>}

        <Disclosure lines={[
          "XRPLHub never holds your money or your keys. You approve the whole batch once, in your own wallet.",
          "All or nothing: if even one payment can't go through, none of them is sent. You only pay the tiny network fee.",
          "Payments on the XRP Ledger can't be undone. Check every address before you approve.",
          "A wallet that doesn't exist yet can be created by paying it at least 1 XRP. RLUSD can only go to wallets that have added RLUSD.",
        ]} />
        <p style={s.small}>For developers and AI agents: POST /api/batch-send (<a href="/openapi.json">OpenAPI</a>) and the XRPLHub MCP server. Uses the XRP Ledger&apos;s Batch feature (all-or-nothing mode).</p>
      </main>
    </div>
  );
}

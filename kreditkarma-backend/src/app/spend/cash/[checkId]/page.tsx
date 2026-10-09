"use client";
// src/app/spend/cash/[checkId]/page.tsx — "Cash this check": the merchant reads the check from the ledger, enters the
// sale amount (up to the check's maximum) and signs the CheckCash in their own wallet. Free.

import React, { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { API, SignPanel, fmtDate, s, type SignData } from "../../ui";

type Check = { checkId: string; from: string; to: string; currency: string; upTo: string; expires: string | null; expired: boolean; writerHolds: number | null; coverable: boolean | null; notes: string[] };

export default function CashPage() {
  const { checkId } = useParams<{ checkId: string }>();
  const [c, setC] = useState<Check | null>(null);
  const [err, setErr] = useState("");
  const [amount, setAmount] = useState("");
  const [sign, setSign] = useState<SignData | null>(null);

  const load = () => fetch(`${API}/api/spend/check/${checkId}`).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.message); setC(j); setAmount((a) => a || j.upTo); }).catch((e) => setErr(e instanceof Error ? e.message : "Could not load the check"));
  useEffect(() => { void load(); }, [checkId]); // eslint-disable-line react-hooks/exhaustive-deps

  const cash = async () => {
    setErr("");
    const r = await fetch(`${API}/api/spend/check/${checkId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amount }) });
    const j = await r.json();
    if (!r.ok) { setErr(j.message ?? "Could not build the transaction"); return; }
    setSign(j);
  };

  return (
    <div style={s.shell}>
      <main style={s.page}>
        <h1 style={s.h1}>Cash this check</h1>
        {!c && !err && <p>Loading the check…</p>}
        {c && (
          <div style={s.card}>
            <p style={{ fontSize: 15 }}>Up to <strong>{c.upTo} {c.currency}</strong>, payable to <span style={s.mono}>{c.to}</span></p>
            <p style={s.small}>From <span style={s.mono}>{c.from}</span> · expires {fmtDate(c.expires)}</p>
            {c.expired && <p style={s.err}>This check has expired and can no longer be cashed.</p>}
            {c.coverable === false && <p style={s.err}>The payer&apos;s wallet holds {c.writerHolds} {c.currency} right now, less than this check. Cashing won&apos;t work unless the money is there.</p>}
            {!c.expired && (
              <>
                <label style={{ ...s.label, marginTop: 10 }}>Amount to cash ({c.currency})</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input style={s.input} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
                  <button style={s.btn} onClick={cash}>Cash it</button>
                </div>
                <p style={s.small}>Approve it in the wallet with the address above. Only that wallet can cash this check.</p>
              </>
            )}
            <ul style={{ fontSize: 12, color: "#555", paddingLeft: 18 }}>{c.notes.map((n) => <li key={n}>{n}</li>)}</ul>
          </div>
        )}
        {sign && <SignPanel data={sign} title={`Cash ${amount} ${c?.currency ?? ""}`} onDone={() => { setSign(null); void load(); }} />}
        {err && <p style={s.err}>{err}</p>}
      </main>
    </div>
  );
}

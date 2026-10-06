"use client";
// src/app/spend/s/[token]/page.tsx — the beneficiary's link: where they can spend and how much is available now.
// No account, no keys, no funds.

import React, { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { API, Disclosure, fmtDate, s } from "../../ui";

type Place = { label: string; category: string; availableNow: string; checks: { amount: string; expires: string; cashLink: string | null }[] };
type ThisPeriod = { periodStart: string; periodEnd: string; amount: string | null; state: string; cashLink: string | null };
const PERIOD_STATE: Record<string, string> = {
  not_signed_yet: "Not paid yet — the payer hasn't signed this period's check", ready_to_cash: "Paid — ready to cash",
  cashed: "Paid and cashed", expired: "Expired before it was cashed", cancelled_by_payer: "Cancelled by the payer", closed: "Closed",
};
type View = { plan: string; kind?: string; thisPeriod?: ThisPeriod; currency: string; places: Place[]; fundsWarning: string | null; howToSpend: string; disclosure: string[] };

export default function SharePage() {
  const { token } = useParams<{ token: string }>();
  const [v, setV] = useState<View | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    fetch(`${API}/api/spend/s/${token}`).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.message); setV(j); }).catch((e) => setErr(e instanceof Error ? e.message : "Could not load"));
  }, [token]);

  if (!v) return <div style={s.shell}><main style={s.page}>{err ? <p style={s.err}>{err}</p> : <p>Loading…</p>}</main></div>;
  return (
    <div style={s.shell}>
      <main style={s.page}>
        <h1 style={s.h1}>{v.plan}</h1>
        <p style={s.sub}>{v.howToSpend}</p>
        {v.thisPeriod && (
          <div style={{ ...s.card, borderColor: v.thisPeriod.state === "ready_to_cash" || v.thisPeriod.state === "cashed" ? "#99d5cc" : "#f0e3a8" }}>
            <p style={s.h2}>This period: {fmtDate(v.thisPeriod.periodStart)} → {fmtDate(v.thisPeriod.periodEnd)}</p>
            <p style={{ fontSize: 15, margin: "0 0 6px" }}><strong>{PERIOD_STATE[v.thisPeriod.state] ?? v.thisPeriod.state}</strong>{v.thisPeriod.amount ? ` · ${v.thisPeriod.amount} ${v.currency}` : ""}</p>
            {v.thisPeriod.cashLink && <a href={v.thisPeriod.cashLink}>Cash this period&apos;s check →</a>}
          </div>
        )}
        {v.fundsWarning && <p style={s.err}>{v.fundsWarning}</p>}
        {v.places.map((p) => (
          <div key={p.label} style={s.card}>
            <p style={s.h2}>{p.label} <span style={{ ...s.small, fontWeight: 400 }}>· {p.category}</span></p>
            {p.checks.length === 0 ? <p style={s.small}>Nothing available right now.</p> : (
              <>
                <p style={{ fontSize: 15, margin: "0 0 6px" }}>Available now: <strong>{p.availableNow} {v.currency}</strong></p>
                {p.checks.map((c, i) => (
                  <p key={i} style={{ fontSize: 14, margin: "4px 0" }}>
                    {p.label}, up to {c.amount} {v.currency}, expires {fmtDate(c.expires)}{" "}
                    {c.cashLink && <a href={c.cashLink}>— merchant: cash this check</a>}
                  </p>
                ))}
              </>
            )}
          </div>
        ))}
        <Disclosure lines={v.disclosure} />
      </main>
    </div>
  );
}

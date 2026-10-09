"use client";
// src/app/spend/s/[token]/page.tsx — the beneficiary's link: where they can spend and how much is available now.
// No account, no keys, no funds.

import React, { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { API, Disclosure, fmtDate, s } from "../../ui";

type Place = { label: string; category: string; availableNow: string; checks: { amount: string; expires: string; cashLink: string | null }[] };
type ThisPeriod = { periodStart: string; periodEnd: string; amount: string | null; state: string; cashLink: string | null; autopay?: { reason: string | null; txHash: string | null } };
const PERIOD_STATE: Record<string, string> = {
  not_signed_yet: "Not paid yet — the payer hasn't approved this period's check", ready_to_cash: "Paid — ready to cash",
  cashed: "Paid and cashed", expired: "Expired before it was cashed", cancelled_by_payer: "Cancelled by the payer", closed: "Closed",
  autopay_scheduled: "Autopay: the payer approved this payment ahead of time. It is sent to you at the start of this period.",
  autopay_paid: "Paid by Autopay — it's already in your wallet", autopay_failed: "Autopay payment didn't go through",
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
          <div style={{ ...s.card, borderColor: v.thisPeriod.state === "autopay_failed" ? "#f2b8b5" : ["ready_to_cash", "cashed", "autopay_paid", "autopay_scheduled"].includes(v.thisPeriod.state) ? "#99d5cc" : "#f0e3a8" }}>
            <p style={s.h2}>This week or month: {fmtDate(v.thisPeriod.periodStart)} → {fmtDate(v.thisPeriod.periodEnd)}</p>
            <p style={{ fontSize: 15, margin: "0 0 6px" }}><strong>{PERIOD_STATE[v.thisPeriod.state] ?? v.thisPeriod.state}</strong>{v.thisPeriod.amount ? ` · ${v.thisPeriod.amount} ${v.currency}` : ""}</p>
            {v.thisPeriod.state === "autopay_failed" && <p style={s.err}>{v.thisPeriod.autopay?.reason ?? "The payment failed."} The payer can approve a normal check instead.</p>}
            {v.thisPeriod.autopay?.txHash && <a href={`https://xrpscan.com/tx/${v.thisPeriod.autopay.txHash}`} target="_blank" rel="noopener noreferrer">See the payment on XRPScan ↗</a>}
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
                    {c.cashLink && <a href={c.cashLink}>— for the shop: cash this check</a>}
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

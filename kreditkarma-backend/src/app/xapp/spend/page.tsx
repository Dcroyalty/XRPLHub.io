"use client";
// src/app/xapp/spend/page.tsx — the Spend Controls xApp (runs INSIDE Xaman; console "WebApp URL" points here).
// Shows ONLY Spend Controls: your plans, this period's checks, new subscription / new budget. No transaction catalog,
// no DEX, nothing Xaman does itself. Every signature is a Xaman sign request opened with the xApp SDK
// (xumm-xapp-sdk openSignRequest) — see SignPanel in ../../spend/ui.tsx.
//
// Flow: Xaman opens ?xAppToken=<one-time token> → POST /api/xapp/session resolves it server-side (the account can't be
// faked) → a 12-hour session in sessionStorage → GET /api/xapp/plans lists this account's plans.

import React, { useEffect, useState } from "react";
import { API, readXapp, s, saveXapp, type XappState } from "../../spend/ui";

type PlanRow = {
  id: string; name: string | null; kind: string; period: string; currency: string; checkSize: string; payees: string[];
  thisPeriod: { checks: number; unsigned: number; open: number }; pushReady: boolean;
};

export default function SpendXapp() {
  const [x, setX] = useState<XappState | null>(null);
  const [plans, setPlans] = useState<PlanRow[] | null>(null);
  const [err, setErr] = useState("");

  // 1. Session: resolve the xAppToken once; reuse the session while navigating inside the xApp.
  useEffect(() => {
    let dead = false;
    (async () => {
      const ott = new URLSearchParams(window.location.search).get("xAppToken");
      const existing = readXapp();
      if (!ott && existing) { setX(existing); return; }
      if (!ott) { setErr("Open this inside the Xaman app (XRPLHub Spend Controls xApp)."); return; }
      try {
        const r = await fetch(`${API}/api/xapp/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ott }) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.message ?? "Could not start the session");
        const st: XappState = { session: j.session, account: j.account, canSign: j.canSign };
        saveXapp(st);
        if (!dead) setX(st);
      } catch (e) {
        if (existing && !dead) setX(existing); // token already used (e.g. reload): keep the session we have
        else if (!dead) setErr(e instanceof Error ? e.message : "Could not start the session");
      }
    })();
    return () => { dead = true; };
  }, []);

  // 2. Plans for this account; tell Xaman the xApp is ready (hides its loader).
  useEffect(() => {
    if (!x) return;
    let dead = false;
    fetch(`${API}/api/xapp/plans`, { headers: { Authorization: `Bearer ${x.session}` } })
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.message); return j; })
      .then((j) => { if (!dead) setPlans(j.plans); })
      .catch((e) => { if (!dead) setErr(e instanceof Error ? e.message : "Could not load your plans"); })
      .finally(() => { import("xumm-xapp-sdk").then(({ xApp }) => { void new xApp().ready(); }).catch(() => {}); });
    return () => { dead = true; };
  }, [x]);

  return (
    <div style={s.shell}>
      <main style={{ ...s.page, paddingTop: 16 }}>
        <h1 style={s.h1}>Spend Controls</h1>
        <p style={s.sub}>Budgets and subscriptions paid by XRPL checks you sign here. Payees cash them with their own wallet. Free.</p>
        {x && <p style={{ ...s.small, marginTop: -10 }}>Account <span style={s.mono}>{x.account}</span>{!x.canSign && " · read-only in Xaman (you can view, not sign)"}</p>}
        {err && <p style={s.err}>{err}</p>}

        {x && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "8px 0 14px" }}>
            <a href="/spend?kind=subscription" style={{ ...s.btn, textDecoration: "none" }}>+ New subscription</a>
            <a href="/spend" style={{ ...s.btnGhost, textDecoration: "none" }}>+ New budget</a>
          </div>
        )}

        {x && plans === null && !err && <p style={s.small}>Loading your plans…</p>}
        {plans && plans.length === 0 && (
          <div style={s.card}>
            <p style={s.h2}>No plans yet</p>
            <p style={s.small}>A subscription pays one payee every week or month: one check per period, sent here for you to sign when that period starts — never ahead. A budget lets someone spend only at payees you approve, up to amounts you set.</p>
          </div>
        )}
        {plans?.map((p) => (
          <a key={p.id} href={`/spend/plan/${p.id}`} style={{ textDecoration: "none", color: "inherit" }}>
            <div style={s.card}>
              <p style={{ ...s.h2, marginBottom: 4 }}>{p.name ?? (p.kind === "subscription" ? "Subscription" : "Spending plan")}</p>
              <p style={s.small}>
                {p.kind === "subscription" ? `Subscription · ${p.checkSize} ${p.currency} ${p.period}` : `Budget · ${p.period} · ${p.payees.length} payee${p.payees.length === 1 ? "" : "s"}`}
                {" · "}{p.payees.slice(0, 3).join(", ")}
              </p>
              <p style={{ fontSize: 14, margin: "6px 0 0" }}>
                {p.thisPeriod.unsigned > 0
                  ? <strong style={{ color: "#b45309" }}>{p.thisPeriod.unsigned} check{p.thisPeriod.unsigned === 1 ? "" : "s"} to sign this period →</strong>
                  : p.thisPeriod.checks > 0 ? <span style={{ color: "#047857" }}>This period is signed ({p.thisPeriod.open} open)</span> : <span style={s.small}>Open to prepare this period →</span>}
              </p>
            </div>
          </a>
        ))}
        <p style={{ ...s.small, marginTop: 14 }}>XRPLHub is not a bank and never holds your funds or keys. Checks don&apos;t lock funds; each open check holds 0.2 XRP of your reserve until it is cashed or cancelled.</p>
      </main>
    </div>
  );
}

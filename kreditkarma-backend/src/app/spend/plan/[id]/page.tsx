"use client";
// src/app/spend/plan/[id]/page.tsx — the funder dashboard (Spend Controls is free): share the beneficiary link, sign this period's checks
// (one signature each, or one for all when Batch is available), and cancel open or expired checks. Live from the ledger.

import React, { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { API, Disclosure, SignPanel, fmtDate, s, type SignData } from "../../ui";

type Check = { invoiceId: string; checkId: string | null; payee: string; category: string; seq: number; amount: string; currency: string; expires: string; status: string; closedHow: string | null };
type Dash = {
  plan: { id: string; name: string | null; funder: string; period: string; checkSize: string; status: string; paidThrough: string | null; shareLink: string };
  paid: boolean;
  period: { start: string; end: string };
  current: Check[]; history: Check[];
  reserve: { perCheckXrp: number; heldNowXrp: number; openChecks: number; note: string };
  funderRlusd: number | null; ledgerSynced: boolean;
  batch: { available: boolean; reason: string };
  disclosure: string[];
};

const STATUS: Record<string, string> = { unsigned: "Not created yet", open: "Open — can be cashed", expired: "Expired — cancel to free the reserve", closed: "Closed" };

export default function PlanDashboard() {
  const { id } = useParams<{ id: string }>();
  const [d, setD] = useState<Dash | null>(null);
  const [err, setErr] = useState("");
  const [sign, setSign] = useState<{ title: string; data: SignData } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API}/api/spend/plans/${id}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.message ?? "Could not load the plan");
      setD(j); setErr("");
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not load the plan"); }
  }, [id]);
  useEffect(() => {
    let dead = false;
    fetch(`${API}/api/spend/plans/${id}`)
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.message ?? "Could not load the plan"); return j; })
      .then((j) => { if (!dead) setD(j); })
      .catch((e) => { if (!dead) setErr(e instanceof Error ? e.message : "Could not load the plan"); });
    return () => { dead = true; };
  }, [id]);

  const post = async (path: string, body: unknown) => {
    setErr("");
    const r = await fetch(`${API}/api/spend/plans/${id}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setErr(j.message ?? "Something went wrong"); return null; }
    return j;
  };
  const signOne = async (c: Check) => { const j = await post("sign", { invoiceId: c.invoiceId }); if (j) setSign({ title: `Sign: check to ${c.payee}, up to ${c.amount} RLUSD`, data: j }); };
  const signBatch = async () => { const j = await post("sign", { batch: true }); if (j) setSign({ title: `Sign once: ${j.count} checks`, data: j }); };
  const cancel = async (c: Check) => { const j = await post("cancel", { checkId: c.checkId }); if (j) setSign({ title: `Cancel the check to ${c.payee} (${c.amount} RLUSD)`, data: j }); };

  if (!d) return <div style={s.shell}><main style={s.page}>{err ? <p style={s.err}>{err}</p> : <p>Loading the plan from the ledger…</p>}</main></div>;
  const share = typeof window !== "undefined" ? `${window.location.origin}${d.plan.shareLink}` : d.plan.shareLink;
  const unsigned = d.current.filter((c) => c.status === "unsigned");

  return (
    <div style={s.shell}>
      <main style={s.page}>
        <a href="/spend" style={s.small}>← Spend Controls</a>
        <h1 style={s.h1}>{d.plan.name ?? "Spending plan"}</h1>
        <p style={s.sub}>Funder <span style={s.mono}>{d.plan.funder}</span> · {d.plan.period} · checks of {d.plan.checkSize} RLUSD</p>
        <p style={{ ...s.small, marginTop: -10 }}>Bookmark this page — its address is your dashboard.</p>

        {sign && <SignPanel data={sign.data} title={sign.title} onDone={() => { setSign(null); void load(); }} />}
        {err && <p style={s.err}>{err}</p>}

        <div style={s.card}>
          <p style={s.h2}>Share with the person you support</p>
          <p style={s.small}>They see where they can spend and how much is available. No account, no keys, no funds.</p>
          <p style={{ ...s.mono, background: "#f4f4f2", padding: 8, borderRadius: 6 }}>{share}</p>
          <button style={s.btnGhost} onClick={() => navigator.clipboard?.writeText(share)}>Copy link</button>
        </div>

        <div style={s.card}>
          <p style={s.h2}>This {d.plan.period === "weekly" ? "week" : "month"}: {fmtDate(d.period.start)} → {fmtDate(d.period.end)}</p>
          {d.paid && unsigned.length > 0 && (
            <p style={s.small}>
              {unsigned.length} check{unsigned.length === 1 ? "" : "s"} to create — sign each one below.{" "}
              {d.batch.available ? <button style={s.btnGhost} onClick={signBatch}>Create up to 8 in one signature</button> : <>One signature for all of them comes once XRPL Batch is live and verified in Xaman ({d.batch.reason}).</>}
            </p>
          )}
          <table style={s.table}>
            <thead><tr><th style={s.th}>Payee</th><th style={s.th}>Up to</th><th style={s.th}>Expires</th><th style={s.th}>Status</th><th style={s.th}></th></tr></thead>
            <tbody>
              {d.current.map((c) => (
                <tr key={c.invoiceId}>
                  <td style={s.td}>{c.payee} #{c.seq}<div style={s.small}>{c.category}</div></td>
                  <td style={s.td}>{c.amount} RLUSD</td>
                  <td style={s.td}>{fmtDate(c.expires)}</td>
                  <td style={s.td}>{STATUS[c.status] ?? c.status}{c.closedHow ? ` (${c.closedHow})` : ""}</td>
                  <td style={s.td}>
                    {c.status === "unsigned" && d.paid && <button style={s.btnGhost} onClick={() => signOne(c)}>Sign</button>}
                    {(c.status === "open" || c.status === "expired") && c.checkId && <button style={s.btnGhost} onClick={() => cancel(c)}>Cancel</button>}
                  </td>
                </tr>
              ))}
              {!d.current.length && <tr><td style={s.td} colSpan={5}>No checks this period.</td></tr>}
            </tbody>
          </table>
        </div>

        <div style={s.card}>
          <p style={s.h2}>Reserve and funds</p>
          <p style={{ fontSize: 14 }}><strong>{d.reserve.heldNowXrp} XRP</strong> of your reserve is held by {d.reserve.openChecks} open or expired check{d.reserve.openChecks === 1 ? "" : "s"} ({d.reserve.perCheckXrp} XRP each). {d.reserve.note}</p>
          <p style={s.small}>Your wallet holds {d.funderRlusd ?? "?"} RLUSD. Checks don&apos;t lock funds — keep enough there for the open checks.</p>
          {!d.ledgerSynced && <p style={s.err}>Could not reach the ledger just now; statuses may be stale. Refresh in a moment.</p>}
        </div>

        {d.history.length > 0 && (
          <div style={s.card}>
            <p style={s.h2}>Earlier checks</p>
            <table style={s.table}><tbody>
              {d.history.map((c) => (
                <tr key={c.invoiceId}><td style={s.td}>{c.payee} #{c.seq}</td><td style={s.td}>{c.amount} RLUSD</td><td style={s.td}>{fmtDate(c.expires)}</td><td style={s.td}>{STATUS[c.status] ?? c.status}{c.closedHow ? ` (${c.closedHow})` : ""}</td>
                  <td style={s.td}>{(c.status === "open" || c.status === "expired") && c.checkId && <button style={s.btnGhost} onClick={() => cancel(c)}>Cancel</button>}</td></tr>
              ))}
            </tbody></table>
          </div>
        )}
        <Disclosure lines={d.disclosure} />
        <button style={s.btnGhost} onClick={() => void load()}>Refresh from the ledger</button>
      </main>
    </div>
  );
}

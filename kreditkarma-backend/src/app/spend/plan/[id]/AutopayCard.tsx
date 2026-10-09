"use client";
// src/app/spend/plan/[id]/AutopayCard.tsx — Autopay for a recurring payment (subscription plans only).
// Set up: one ticket approval, then one sign-only approval per future period. On: the schedule. Cancel: stop at once,
// then release each remaining ticket. Every step is a Xaman request the payer approves; XRPLHub never signs.

import React, { useState } from "react";
import { API, Disclosure, SignPanel, fmtDate, s, type SignData } from "../../ui";

export type AutopayView = {
  available: boolean; status: string; maxPeriods: number; reservePerTicketXrp: number;
  payments: { ticket: number; periodStart: string; periodEnd: string; amount: string; status: string; reason: string | null; txHash: string | null }[];
  releasableTickets: number[] | null; disclosure: string[];
};

const LABEL: Record<string, string> = {
  unsigned: "Not approved yet", scheduled: "Approved — will be sent", pending: "Sent — confirming", paid: "Paid",
  failed: "Didn't go through", missed: "Not sent", cancelled: "Cancelled",
};

export function AutopayCard({ planId, view, currency, period, onChange }: { planId: string; view: AutopayView; currency: string; period: string; onChange: () => void }) {
  const [n, setN] = useState(period === "weekly" ? 4 : 6);
  const [sign, setSign] = useState<{ title: string; data: SignData; approveOnly?: boolean; after: (uuid: string) => Promise<void> } | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const unit = period === "weekly" ? "week" : "month";

  const post = async (body: Record<string, unknown>) => {
    setErr(""); setBusy(true);
    try {
      const r = await fetch(`${API}/api/spend/plans/${planId}/autopay`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j.message ?? "Something went wrong."); return null; }
      return j;
    } finally { setBusy(false); }
  };

  // After the ticket approval: Xaman submits it; poll until the ledger has validated it (a few seconds).
  const confirmTickets = async () => {
    for (let i = 0; i < 10; i++) {
      const j = await post({ action: "tickets" });
      if (!j) return;
      if (j.state === "ready") { onChange(); return; }
      if (j.state === "expired" || j.state === "declined") { setErr(j.state === "expired" ? "That request expired. Start again." : "You declined it. Nothing was set up."); onChange(); return; }
      await new Promise((res) => setTimeout(res, 3000));
    }
    setErr("Still waiting for the ledger. Press the button again in a moment.");
  };

  const start = async () => {
    const j = await post({ action: "start", periods: n });
    if (j) setSign({ title: `Approve Autopay setup for ${n} payment${n === 1 ? "" : "s"} (holds ${j.reserveXrp} XRP until used or released)`, data: j, after: async () => { await confirmTickets(); } });
  };
  const approveNext = async () => {
    const j = await post({ action: "sign" });
    if (!j) { onChange(); return; }
    setSign({
      title: `Approve payment ${j.index} of ${j.total}: ${j.amount} ${j.currency}, sent on ${fmtDate(j.periodStart)}`,
      data: { uuid: j.uuid, qr_png: j.qr_png, deep_link: j.deep_link, websocket: j.websocket },
      approveOnly: true,
      after: async (uuid) => { await post({ action: "signed", uuid }); },
    });
  };
  const cancel = async () => {
    if (!window.confirm("Cancel Autopay? We stop sending at once. Then release the remaining tickets to make those payments impossible and get your XRP back.")) return;
    if (await post({ action: "cancel" })) onChange();
  };
  const release = async (t: number) => {
    const j = await post({ action: "release", tickets: [t] });
    if (j) setSign({ title: `Release this payment (cancels it for good, returns its ${view.reservePerTicketXrp} XRP)`, data: j, after: async () => {} });
  };

  const st = view.status;
  const live = view.payments.filter((p) => p.status !== "cancelled");
  const unsigned = view.payments.filter((p) => p.status === "unsigned").length;

  return (
    <div style={{ ...s.card, borderColor: "#99d5cc" }}>
      <p style={s.h2}>Autopay {st === "on" ? "· on" : st === "signing" ? "· finish setting up" : ""}</p>
      {!view.available && <p style={s.small}>Autopay isn&apos;t available yet. Keep approving each {unit}&apos;s payment.</p>}

      {view.available && (st === "off" || st === "ended") && (
        <>
          <p style={{ fontSize: 14, margin: "0 0 8px" }}>Approve the next payments now, all at once. XRPLHub decides when each one is sent: one at the start of each {unit}, never early. No more approving every {unit}.</p>
          <label style={s.label}>How many {unit}s ahead</label>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <select style={{ ...s.input, width: 120 }} value={n} onChange={(e) => setN(Number(e.target.value))}>
              {Array.from({ length: view.maxPeriods }, (_, k) => k + 1).map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <button type="button" style={s.btn} disabled={busy} onClick={start}>Set up Autopay →</button>
          </div>
          <p style={{ ...s.small, marginTop: 6 }}>Each pre-approved payment holds {view.reservePerTicketXrp} XRP in your wallet until it&apos;s used or released ({Number((view.reservePerTicketXrp * n).toFixed(6))} XRP for {n}). Starts next {unit}; this {unit} is paid the usual way.</p>
        </>
      )}

      {st === "tickets" && (
        <p style={{ fontSize: 14 }}>Waiting for your ticket approval in Xaman. <button type="button" style={s.btnGhost} disabled={busy} onClick={confirmTickets}>I approved it</button></p>
      )}
      {st === "signing" && unsigned > 0 && (
        <p style={{ fontSize: 14 }}>{unsigned} payment{unsigned === 1 ? "" : "s"} left to approve. Approving does not send anything. <button type="button" style={s.btn} disabled={busy} onClick={approveNext}>Approve the next one →</button></p>
      )}

      {sign && <SignPanel data={sign.data} title={sign.title} approveOnly={sign.approveOnly} onSigned={(uuid) => { void sign.after(uuid).then(onChange); }} onDone={() => { setSign(null); onChange(); }} />}
      {err && <p style={s.err}>{err}</p>}

      {live.length > 0 && (
        <table style={{ ...s.table, marginTop: 8 }}>
          <thead><tr><th style={s.th}>{unit === "week" ? "Week of" : "Month of"}</th><th style={s.th}>Amount</th><th style={s.th}>Status</th></tr></thead>
          <tbody>
            {live.map((p) => (
              <tr key={p.ticket}>
                <td style={s.td}>{fmtDate(p.periodStart)}</td>
                <td style={s.td}>{p.amount} {currency}</td>
                <td style={s.td}>
                  {LABEL[p.status] ?? p.status}
                  {p.reason && p.status !== "cancelled" && <div style={s.err}>{p.reason} You can approve a normal check for it instead.</div>}
                  {p.txHash && <div><a style={s.small} href={`https://xrpscan.com/tx/${p.txHash}`} target="_blank" rel="noreferrer">XRPScan ↗</a></div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {(st === "on" || st === "signing" || st === "tickets") && (
        <button type="button" style={{ ...s.btnGhost, marginTop: 10 }} disabled={busy} onClick={cancel}>Cancel Autopay</button>
      )}

      {!!view.releasableTickets?.length && (
        <div style={{ marginTop: 12 }}>
          <p style={{ fontSize: 14, margin: "0 0 6px" }}><strong>Release the cancelled payments</strong> to make them impossible to send, by anyone, and get {view.reservePerTicketXrp} XRP back for each.</p>
          {view.releasableTickets.map((t) => { const p = view.payments.find((x) => x.ticket === t); return <button key={t} type="button" style={{ ...s.btnGhost, marginRight: 6, marginBottom: 6 }} disabled={busy} onClick={() => release(t)}>Release {p ? `the ${fmtDate(p.periodStart)} payment` : `payment #${t}`}</button>; })}
        </div>
      )}

      {view.available && <Disclosure lines={view.disclosure} />}
    </div>
  );
}

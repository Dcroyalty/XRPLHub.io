"use client";
// src/app/spend/plan/[id]/page.tsx — the funder dashboard (Spend Controls is free): share the beneficiary link, sign this period's checks
// (one signature each, or one for all when Batch is available), and cancel open or expired checks. Live from the ledger.

import React, { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { API, Disclosure, SignPanel, XappFooter, fmtDate, s, useXapp, v, type Explain, type SignData, LedgerBanner } from "../../ui";
import { AutopayCard, type AutopayView } from "./AutopayCard";

type Check = { invoiceId: string; checkId: string | null; payee: string; category: string; seq: number; amount: string; currency: string; expires: string; status: string; closedHow: string | null };
type Dash = {
  plan: { id: string; name: string | null; kind: string; funder: string; period: string; checkSize: string; currency: string; status: string; paidThrough: string | null; shareLink: string };
  pushReady: boolean; funderBalance: number | null;
  paid: boolean;
  period: { start: string; end: string };
  current: Check[]; history: Check[];
  reserve: { perCheckXrp: number; heldNowXrp: number; openChecks: number; note: string };
  funderRlusd: number | null; ledgerSynced: boolean;
  batch: { available: boolean; reason: string };
  disclosure: string[];
  autopay: AutopayView | null;
};

const STATUS: Record<string, string> = { unsigned: "Not approved yet", open: "Ready — can be cashed", expired: "Expired — cancel it to get your 0.2 XRP back", closed: "Closed", autopay: "Paid by Autopay" };

export default function PlanDashboard() {
  const { id } = useParams<{ id: string }>();
  const [d, setD] = useState<Dash | null>(null);
  const [err, setErr] = useState("");
  const [sign, setSign] = useState<{ title: string; data: SignData; explain?: Explain } | null>(null);
  const xapp = useXapp();
  const [confirmEnd, setConfirmEnd] = useState(false);

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
  // After a signature: let the server keep Xaman's push token, so next period's subscription check reaches the app.
  const onSigned = (uuid: string) => { void fetch(`${API}/api/spend/plans/${id}/signed`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uuid }) }).catch(() => {}); };
  const cur = d?.plan.currency ?? "RLUSD";
  // Plain-words explanation shown before every signature (inside the xApp: before the Xaman screen opens).
  const checkExplain = (payees: string, n: number, upTo: string, expires: string, isSub: boolean): Explain => ({
    what: n === 1 ? `A check from your wallet to ${payees}, for up to ${upTo}.` : `${n} checks from your wallet in one approval (${upTo} in total): ${payees}. All of them are created, or none.`,
    why: isSub ? "This is this period's payment for your recurring plan. Nothing is made ahead of time." : "This is this period's allowance at the places you picked.",
    consequences: [
      `${n === 1 ? "The person you pay can cash it" : "Each one can be cashed"} any time until ${expires}, for up to the amount shown. Money isn't set aside — keep enough in your wallet.`,
      `Each open check holds 0.2 XRP of your wallet's reserve (${(0.2 * n).toFixed(1)} XRP here) until it's cashed or cancelled. You get it back then.`,
      "You can cancel any check here before it's cashed. A cashed check can't be undone.",
    ],
  });
  const isSub = d?.plan.kind === "subscription";
  const signOne = async (c: Check) => { const j = await post("sign", { invoiceId: c.invoiceId }); if (j) setSign({ title: `${xapp ? "Approve" : "Sign"}: check to ${c.payee}, up to ${c.amount} ${cur}`, data: j, explain: checkExplain(c.payee, 1, `${c.amount} ${cur}`, fmtDate(c.expires), isSub) }); };
  const signBatch = async () => {
    const j = await post("sign", { batch: true });
    if (!j || !d) return;
    const picked = d.current.filter((c) => ((j.invoiceIds as string[] | undefined) ?? []).includes(c.invoiceId));
    const total = picked.reduce((a, c) => a + Number(c.amount), 0);
    setSign({ title: `${xapp ? "Approve" : "Sign"} once: ${j.count} checks`, data: j, explain: checkExplain([...new Set(picked.map((c) => c.payee))].join(", "), j.count, `${Number(total.toFixed(6))} ${cur}`, picked[0] ? fmtDate(picked[0].expires) : "the end of this period", isSub) });
  };
  const cancel = async (c: Check) => {
    const j = await post("cancel", { checkId: c.checkId });
    if (j) setSign({ title: `Cancel the check to ${c.payee} (${c.amount} ${cur})`, data: j, explain: {
      what: `Cancel the check to ${c.payee} for up to ${c.amount} ${cur}.`,
      why: "You no longer want it to be cashable (or it expired and still holds your reserve).",
      consequences: ["After this, nobody can cash it.", "The 0.2 XRP it held is free again in your wallet.", "Nothing else changes; your plan stays as it is."],
    } });
  };

  const endPlan = async () => {
    const j = await post("end", {});
    if (j) { setConfirmEnd(false); void load(); }
  };

  if (!d) return <div style={s.shell}><main style={s.page}><LedgerBanner />{err ? <p style={s.err}>{err}</p> : <p>Loading…</p>}</main></div>;
  const share = typeof window !== "undefined" ? `${window.location.origin}${d.plan.shareLink}` : d.plan.shareLink;
  const unsigned = d.current.filter((c) => c.status === "unsigned");
  const sub = d.plan.kind === "subscription";
  const ended = d.plan.status === "ended";
  const openNow = d.reserve.openChecks;

  return (
    <div style={s.shell}>
      <main style={s.page}><LedgerBanner />
        {xapp ? <a href="/xapp/spend" style={s.small}>← My plans</a> : <a href="/spend" style={s.small}>← Spend Controls</a>}
        <h1 style={s.h1}>{d.plan.name ?? (sub ? "Recurring payment" : "Allowance")}</h1>
        <p style={s.sub}>{sub ? "Recurring payment" : "Allowance"} · paid from <span style={s.mono}>{d.plan.funder}</span> · {d.plan.period} · {sub ? `${d.plan.checkSize} ${cur} each time` : `checks of ${d.plan.checkSize} ${cur}`}</p>
        {ended && (
          <div style={{ ...s.card, background: v("warn-bg", "#fffbea"), borderColor: v("warn-border", "#f0e3a8") }}>
            <p style={{ ...s.h2, fontSize: 15 }}>This plan has ended</p>
            <p style={{ ...s.small, color: v("warn-fg", "#4a4a3a"), margin: 0 }}>
              No new payments are made or sent to you to approve, and it no longer shows in your list in Xaman.
              {openNow > 0 ? ` ${openNow} check${openNow === 1 ? " is" : "s are"} still open and can be cashed until you cancel ${openNow === 1 ? "it" : "them"} below.` : " Nothing is left open."}
            </p>
          </div>
        )}
        {sub && !ended && (
          <div style={{ ...s.card, background: d.pushReady ? v("ok-bg", "#eef8f6") : v("warn-bg", "#fffbea") }}>
            <p style={{ ...s.small, color: v("fg", "#333"), margin: 0 }}>
              {d.pushReady
                ? "Reminders on: when a new week or month starts, that payment is sent to your Xaman app to approve. Nothing is made ahead of time."
                : "Reminders are off. Xaman only lets us send payments to your app within 30 days of your last approval for XRPLHub. Approve this period's check in Xaman to turn them back on, or check this page when each week or month starts. Nothing is made ahead of time."}
            </p>
          </div>
        )}
        {!xapp && <p style={{ ...s.small, marginTop: -10 }}>Bookmark this page — its address is your dashboard.</p>}

        {sign && <SignPanel data={sign.data} title={sign.title} explain={sign.explain} onSigned={onSigned} onDone={() => { setSign(null); void load(); }} />}
        {err && <p style={s.err}>{err}</p>}

        <div style={s.card}>
          <p style={s.h2}>{sub ? "Share with the person you pay" : "Share with the person you support"}</p>
          <p style={s.small}>{sub ? "They see whether this period is paid, and cash the check with their own wallet." : "They see where they can spend and how much is available."} They don&apos;t need an account.</p>
          <p style={{ ...s.mono, background: v("subtle", "#f4f4f2"), padding: 8, borderRadius: 6 }}>{share}</p>
          <button style={s.btnGhost} onClick={() => navigator.clipboard?.writeText(share)}>Copy link</button>
        </div>

        <div style={s.card}>
          <p style={s.h2}>This {d.plan.period === "weekly" ? "week" : "month"}: {fmtDate(d.period.start)} → {fmtDate(d.period.end)}</p>
          {d.paid && unsigned.length > 0 && (
            <p style={s.small}>
              {unsigned.length} check{unsigned.length === 1 ? "" : "s"} to approve — approve each one below.{" "}
              {d.batch.available ? <button style={s.btnGhost} onClick={signBatch}>Approve up to 8 at once</button> : <>Approving them all at once isn&apos;t available yet ({d.batch.reason}).</>}
            </p>
          )}
          {xapp ? (
            // Inside the xApp: one card per check, full-width buttons — nothing is cut off on small Android screens.
            <div>
              {d.current.map((c) => (
                <div key={c.invoiceId} style={{ borderTop: `1px solid ${v("row", "#f0f0ec")}`, padding: "10px 0" }}>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>{c.payee} <span style={{ ...s.small, fontWeight: 400 }}>#{c.seq} · {c.category}</span></div>
                  <div style={{ fontSize: 14 }}>Up to {c.amount} {cur} · until {fmtDate(c.expires)}</div>
                  <div style={{ ...s.small, margin: "2px 0 6px" }}>{STATUS[c.status] ?? c.status}{c.closedHow ? ` (${c.closedHow})` : ""}</div>
                  {c.status === "unsigned" && d.paid && <button style={{ ...s.btn, width: "100%" }} onClick={() => signOne(c)}>Approve this check</button>}
                  {(c.status === "open" || c.status === "expired") && c.checkId && <button style={{ ...s.btnGhost, width: "100%" }} onClick={() => cancel(c)}>Cancel this check</button>}
                </div>
              ))}
              {!d.current.length && <p style={s.small}>No checks this week or month.</p>}
            </div>
          ) : (
            <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}><table style={{ ...s.table, minWidth: xapp ? 360 : undefined }}>
              <thead><tr><th style={s.th}>Paid to</th><th style={s.th}>Up to</th><th style={s.th}>Expires</th><th style={s.th}>Status</th><th style={s.th}></th></tr></thead>
              <tbody>
                {d.current.map((c) => (
                  <tr key={c.invoiceId}>
                    <td style={s.td}>{c.payee} #{c.seq}<div style={s.small}>{c.category}</div></td>
                    <td style={s.td}>{c.amount} {cur}</td>
                    <td style={s.td}>{fmtDate(c.expires)}</td>
                    <td style={s.td}>{STATUS[c.status] ?? c.status}{c.closedHow ? ` (${c.closedHow})` : ""}</td>
                    <td style={s.td}>
                      {c.status === "unsigned" && d.paid && <button style={s.btnGhost} onClick={() => signOne(c)}>Approve</button>}
                      {(c.status === "open" || c.status === "expired") && c.checkId && <button style={s.btnGhost} onClick={() => cancel(c)}>Cancel</button>}
                    </td>
                  </tr>
                ))}
                {!d.current.length && <tr><td style={s.td} colSpan={5}>No checks this week or month.</td></tr>}
              </tbody>
            </table></div>
          )}
        </div>

        {sub && d.autopay && <AutopayCard planId={d.plan.id} view={d.autopay} currency={cur} period={d.plan.period} onChange={() => void load()} />}

        <div style={s.card}>
          <p style={s.h2}>Your wallet</p>
          <p style={{ fontSize: 14 }}><strong>{d.reserve.heldNowXrp} XRP</strong> is set aside in your wallet by {d.reserve.openChecks} open or expired check{d.reserve.openChecks === 1 ? "" : "s"} ({d.reserve.perCheckXrp} XRP each). {d.reserve.note}</p>
          <p style={s.small}>Your wallet holds {(() => { const b = d.funderBalance ?? d.funderRlusd; return b == null ? "?" : xapp ? Number(b.toFixed(6)) : b; })()} {cur}{cur === "XRP" ? " above its reserve" : ""}. Checks don&apos;t set money aside, so keep enough there to cover them.</p>
          {!d.ledgerSynced && <p style={s.err}>Could not get the latest status just now. Refresh in a moment.</p>}
        </div>

        {d.history.length > 0 && (
          <div style={s.card}>
            <p style={s.h2}>Earlier checks</p>
            {xapp ? (
              <div>
                {d.history.map((c) => (
                  <div key={c.invoiceId} style={{ borderTop: `1px solid ${v("row", "#f0f0ec")}`, padding: "8px 0", fontSize: 14 }}>
                    <div><strong>{c.payee}</strong> #{c.seq} · {c.amount} {cur} · {fmtDate(c.expires)}</div>
                    <div style={s.small}>{STATUS[c.status] ?? c.status}{c.closedHow ? ` (${c.closedHow})` : ""}</div>
                    {(c.status === "open" || c.status === "expired") && c.checkId && <button style={{ ...s.btnGhost, width: "100%", marginTop: 6 }} onClick={() => cancel(c)}>Cancel this check</button>}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ overflowX: "auto" }}><table style={{ ...s.table, minWidth: xapp ? 320 : undefined }}><tbody>
                {d.history.map((c) => (
                  <tr key={c.invoiceId}><td style={s.td}>{c.payee} #{c.seq}</td><td style={s.td}>{c.amount} {cur}</td><td style={s.td}>{fmtDate(c.expires)}</td><td style={s.td}>{STATUS[c.status] ?? c.status}{c.closedHow ? ` (${c.closedHow})` : ""}</td>
                    <td style={s.td}>{(c.status === "open" || c.status === "expired") && c.checkId && <button style={s.btnGhost} onClick={() => cancel(c)}>Cancel</button>}</td></tr>
                ))}
              </tbody></table></div>
            )}
          </div>
        )}
        <Disclosure lines={d.disclosure} />
        <button style={s.btnGhost} onClick={() => void load()}>Refresh</button>
        {!ended && (
          <div style={{ ...s.card, marginTop: 14, background: v("danger-bg", "#fff7f6"), borderColor: v("danger-border", "#f2b8b5") }}>
            <p style={s.h2}>End this plan</p>
            <p style={s.small}>
              Stops this {sub ? "recurring payment" : "allowance"} for good: no new checks, nothing more sent to your Xaman app{d.autopay && d.autopay.status !== "off" ? ", and Autopay payments not yet sent are cancelled" : ""}.
              Checks already made stay cashable until you cancel them on this page.{d.autopay && d.autopay.status !== "off" ? " Release the remaining Autopay payments here afterwards to get their XRP back." : ""} To start again, make a new plan.
            </p>
            {confirmEnd ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button style={{ ...s.btn, flex: "1 1 140px" }} onClick={() => void endPlan()}>Yes, end it</button>
                <button style={{ ...s.btnGhost, flex: "1 1 140px" }} onClick={() => setConfirmEnd(false)}>Keep it</button>
              </div>
            ) : <button style={s.btnGhost} onClick={() => setConfirmEnd(true)}>End this plan…</button>}
          </div>
        )}
        {xapp && <XappFooter />}
      </main>
    </div>
  );
}

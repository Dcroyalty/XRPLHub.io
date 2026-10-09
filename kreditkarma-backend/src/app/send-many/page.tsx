"use client";
// src/app/send-many/page.tsx — BATCH SEND for people: "pay up to 8 people with one approval — everyone or no one."
// Steps: 1) sign in with Xaman (no typing your own address), 2) add who you pay, 3) approve the batch in Xaman (QR right
// there), 4) DONE only when the XRP Ledger shows every payment (GET /api/batch-send?uuid=…). Free.

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { API, ConnectXaman, Disclosure, s, useSignedInWallet } from "../spend/ui";
import { watchXaman } from "@/lib/wallet/xamanWatch";

type Row = { address: string; amount: string; currency: "XRP" | "RLUSD"; destinationTag: string; label: string };
type Problem = { index: number; address: string; error: string };
type Prepared = { uuid: string | null; qr_png: string | null; deep_link: string | null; websocket: string | null; totals: { xrp: number; rlusd: number }; networkFeeXrp: number; payments: number; txjson: Record<string, unknown> };
type Status = { state: string; txHash?: string; ledgerIndex?: number; payments?: { destination: string; amount: unknown; applied: boolean; result: string; txHash: string | null }[] };
const blank = (): Row => ({ address: "", amount: "", currency: "XRP", destinationTag: "", label: "" });
const amt = (a: unknown) => (typeof a === "string" ? `${Number(a) / 1e6} XRP` : `${(a as { value?: string })?.value ?? "?"} RLUSD`);

export default function SendManyPage() {
  const [wallet, setWallet] = useSignedInWallet();
  const [manual, setManual] = useState("");
  const [typing, setTyping] = useState(false);
  const from = wallet || (typing ? manual.trim() : "");
  const [rows, setRows] = useState<Row[]>([blank(), blank()]);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [prep, setPrep] = useState<Prepared | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const approveRef = useRef<HTMLDivElement>(null);

  const set = (i: number, k: keyof Row, v: string) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const total = (c: "XRP" | "RLUSD") => rows.filter((r) => r.currency === c).reduce((a, r) => a + (Number(r.amount) || 0), 0);

  const prepare = async () => {
    setBusy(true); setErr(""); setProblems([]); setPrep(null); setStatus(null);
    try {
      const res = await fetch(`${API}/api/batch-send`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, recipients: rows.map((r) => ({ address: r.address.trim(), amount: r.amount.trim(), currency: r.currency, destinationTag: r.destinationTag.trim() === "" ? null : Number(r.destinationTag), label: r.label })) }),
      });
      const j = await res.json();
      if (!res.ok) { setErr(j.message ?? "Something went wrong."); setProblems(j.problems ?? []); return; }
      setPrep(j);
      setStatus({ state: "waiting_signature" });
      setTimeout(() => approveRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    } catch { setErr("Something went wrong. Try again."); }
    finally { setBusy(false); }
  };

  // After approval, ask the LEDGER (via our status endpoint) until the batch is settled. Never claim done before.
  useEffect(() => {
    if (!prep?.uuid) return;
    const uuid = prep.uuid;
    let stop = false, t: ReturnType<typeof setTimeout> | null = null;
    const ask = async (): Promise<boolean> => {
      try {
        const r = await fetch(`${API}/api/batch-send?uuid=${uuid}`);
        const d = (await r.json()) as Status;
        if (stop) return true;
        setStatus(d);
        return ["done", "failed", "declined", "expired"].includes(d.state);
      } catch { return false; }
    };
    const xw = watchXaman(uuid, () => {
      // Resolved in Xaman: the ledger needs a few seconds — check every 3 s for up to a minute.
      if (t) clearTimeout(t);
      let n = 0;
      const settle = async () => { if (stop || (await ask()) || ++n > 20) return; t = setTimeout(settle, 3000); };
      void settle();
    }, prep.websocket);
    const slow = async () => { if (stop || (await ask())) return; t = setTimeout(slow, xw.delay()); };
    t = setTimeout(slow, xw.delay());
    return () => { stop = true; xw.stop(); if (t) clearTimeout(t); };
  }, [prep]);

  const st = status?.state;
  return (
    <div style={s.shell}>
      <main style={s.page}>
        <Link href="/" style={s.small}>← XRPLHub</Link>
        <h1 style={s.h1}>Pay up to 8 people with one approval</h1>
        <p style={s.sub}>
          Send XRP or RLUSD (a digital US dollar) to several people at once. You approve it once in your own wallet. Either
          everyone gets paid, or nobody does — never half. Free. We check every payment first and tell you if one can&apos;t go through.
        </p>

        <p style={{ ...s.h2, fontSize: 14 }}>Step 1 · Your wallet</p>
        <ConnectXaman wallet={wallet} onChange={setWallet} purpose="you pay from it" />
        {wallet === "" && (
          typing
            ? <div style={s.card}><label style={s.label}>Your XRP wallet address</label><input style={{ ...s.input, ...s.mono }} value={manual} onChange={(e) => setManual(e.target.value)} placeholder="r…" /></div>
            : <p style={{ ...s.small, marginTop: -6 }}>Not using Xaman? <button type="button" style={{ ...s.btnGhost, padding: "2px 8px" }} onClick={() => setTyping(true)}>Type your address instead</button></p>
        )}

        {from && !prep && (
          <>
            <p style={{ ...s.h2, fontSize: 14, marginTop: 16 }}>Step 2 · Who you pay ({rows.length} of 8)</p>
            <div style={s.card}>
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
          </>
        )}

        {prep && (
          <div ref={approveRef} style={{ ...s.card, borderColor: st === "done" ? "#99d5cc" : st === "failed" || st === "declined" || st === "expired" ? "#f2b8b5" : "#0f766e", borderWidth: 2, marginTop: 16 }}>
            {(st === "waiting_signature" || !st) && (
              <>
                <p style={{ ...s.h2, fontSize: 18 }}>Step 3 · Now approve it in Xaman</p>
                <p style={{ fontSize: 14, margin: "0 0 8px" }}>Nothing has been sent yet. Scan this with Xaman (or tap the link on your phone) and approve paying {prep.payments} people{prep.totals.xrp ? ` ${prep.totals.xrp} XRP` : ""}{prep.totals.rlusd ? ` ${prep.totals.rlusd} RLUSD` : ""}.</p>
                {prep.qr_png && <img src={prep.qr_png} alt="Scan with Xaman to approve" style={{ width: 200, height: 200, display: "block", margin: "6px auto" }} />}
                {prep.deep_link && <p style={{ textAlign: "center", margin: "4px 0 10px" }}><a href={prep.deep_link} target="_blank" rel="noreferrer">Open in Xaman →</a></p>}
                <p style={s.small}>Network fee for the whole batch: {prep.networkFeeXrp} XRP. Approve it before sending anything else from this wallet — otherwise the XRP Ledger refuses it and nobody is paid.</p>
              </>
            )}
            {st === "pending_ledger" && <p style={{ fontSize: 15 }}>Approved in Xaman. Waiting for the XRP Ledger to confirm every payment…</p>}
            {st === "done" && (
              <>
                <p style={{ ...s.h2, fontSize: 18, color: "#047857" }}>Done — all {status?.payments?.length} payments are on the XRP Ledger.</p>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14 }}>
                  {status?.payments?.map((p) => <li key={p.destination}>{amt(p.amount)} to <span style={s.mono}>{p.destination}</span> {p.txHash && <a href={`https://xrpscan.com/tx/${p.txHash}`} target="_blank" rel="noreferrer">XRPScan ↗</a>}</li>)}
                </ul>
                {status?.txHash && <p style={s.small}>Batch <a href={`https://xrpscan.com/tx/${status.txHash}`} target="_blank" rel="noreferrer">{status.txHash.slice(0, 12)}…</a> in ledger {status.ledgerIndex?.toLocaleString()}.</p>}
              </>
            )}
            {st === "failed" && <p style={s.err}>The XRP Ledger didn&apos;t apply this batch, so nobody was paid (all or nothing). Nothing left your wallet except the tiny network fee.{status?.txHash ? ` Batch ${status.txHash.slice(0, 12)}…` : ""}</p>}
            {st === "declined" && <p style={s.err}>You declined it in Xaman. Nothing was sent.</p>}
            {st === "expired" && <p style={s.err}>The approval request expired. Nothing was sent.</p>}
            {(st === "done" || st === "failed" || st === "declined" || st === "expired") && <button type="button" style={{ ...s.btnGhost, marginTop: 8 }} onClick={() => { setPrep(null); setStatus(null); }}>{st === "done" ? "Send another batch" : "Go back and try again"}</button>}
          </div>
        )}

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

"use client";
// src/app/permissions/page.tsx — WALLET PERMISSIONS CHECK for people: "who can move money out of this wallet?"
// Free. Reads GET /api/permissions/:address; the free fixes (remove a delegation, cancel a check) go through
// POST /api/permissions/fix and are signed in the owner's own wallet.

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { API, ConnectXaman, SignPanel, s, useSignedInWallet, type SignData } from "../spend/ui";

type Finding = { kind: string; level: "danger" | "warning" | "info" | "ok"; who: string | null; plain: string; detail: Record<string, unknown>; fix?: { action: string; params: Record<string, string> } };
type Report = { address: string; exists: boolean; headline: string; canMoveMoney: { who: string; how: string }[]; findings: Finding[]; truncated: boolean; notes: string[]; ledgerIndex: number | null };

const BADGE: Record<Finding["level"], { label: string; bg: string; fg: string }> = {
  danger: { label: "Can take money", bg: "#fde8e8", fg: "#9b1c1c" },
  warning: { label: "Check this", bg: "#fff4d6", fg: "#8a5a00" },
  info: { label: "Good to know", bg: "#eef2ff", fg: "#3730a3" },
  ok: { label: "Normal", bg: "#e8f7f0", fg: "#065f46" },
};
const FIX_LABEL: Record<string, string> = { revoke_delegation: "Remove this permission (free)", cancel_check: "Cancel this check (free)" };

export default function PermissionsPage() {
  const [address, setAddress] = useState("");
  const [r, setR] = useState<Report | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [sign, setSign] = useState<{ title: string; data: SignData } | null>(null);
  const [wallet, setWallet] = useSignedInWallet();

  const run = async (a = address) => {
    const v = a.trim();
    if (!v) return;
    setBusy(true); setErr(""); setR(null); setSign(null);
    try {
      const res = await fetch(`${API}/api/permissions/${encodeURIComponent(v)}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.message ?? "Something went wrong.");
      setR(j);
      try { window.history.replaceState(null, "", `/permissions?address=${v}`); } catch { /* fine */ }
    } catch (e) { setErr(e instanceof Error ? e.message : "Something went wrong."); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    if (wallet === null) return; // not mounted yet
    const a = new URLSearchParams(window.location.search).get("address") || wallet;
    if (a) { setAddress(a); void run(a); } // eslint-disable-line react-hooks/set-state-in-effect
  }, [wallet]); // eslint-disable-line react-hooks/exhaustive-deps

  const fix = async (f: Finding) => {
    if (!f.fix) return;
    setErr("");
    const res = await fetch(`${API}/api/permissions/fix`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: f.fix.action, ...f.fix.params }) });
    const j = await res.json();
    if (!res.ok) { setErr(j.message ?? "Couldn't prepare that."); return; }
    setSign({ title: FIX_LABEL[f.fix.action] ?? "Approve in your wallet", data: j });
  };

  return (
    <div style={s.shell}>
      <main style={s.page}>
        <Link href="/" style={s.small}>← XRPLHub</Link>
        <h1 style={s.h1}>Who can move money from my wallet?</h1>
        <p style={s.sub}>
          Paste any XRP wallet address. We read the XRP Ledger and list everyone who can move money out of it — a second key,
          a group of signers, someone you gave permission to act for you, a check someone can cash — and how to remove the
          ones you don&apos;t want. Free, no sign-up. We never see your keys.
        </p>

        <ConnectXaman wallet={wallet} onChange={setWallet} purpose="we check your own wallet" />
        <p style={{ ...s.small, margin: "0 0 6px" }}>{wallet ? "Or check any other wallet:" : "Or paste any wallet address:"}</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
          <input style={{ ...s.input, ...s.mono, flex: "1 1 260px" }} value={address} onChange={(e) => setAddress(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()} placeholder="Paste an XRP wallet address (starts with r)…" />
          <button type="button" style={s.btn} disabled={busy} onClick={() => run()}>{busy ? "Checking…" : "Check →"}</button>
        </div>
        {err && <p style={s.err}>{err}</p>}

        {r && (
          <>
            <div style={{ ...s.card, borderColor: r.canMoveMoney.length ? "#f2b8b5" : "#99d5cc", background: r.canMoveMoney.length ? "#fff7f6" : "#f2fbf8" }}>
              <p style={{ ...s.h2, fontSize: 18 }}>{r.headline}</p>
              {r.canMoveMoney.length > 0 && (
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14 }}>
                  {r.canMoveMoney.map((m) => <li key={m.who + m.how}><span style={s.mono}>{m.who}</span> — {m.how}</li>)}
                </ul>
              )}
              <p style={{ ...s.small, marginTop: 8 }}>Read from the XRP Ledger{r.ledgerIndex ? ` at ledger ${r.ledgerIndex.toLocaleString()}` : ""}. <span style={s.mono}>{r.address}</span></p>
            </div>

            {sign && <SignPanel data={sign.data} title={sign.title} onDone={() => { setSign(null); void run(r.address); }} />}

            {r.findings.map((f, i) => (
              <div key={i} style={s.card}>
                <span style={{ display: "inline-block", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 99, background: BADGE[f.level].bg, color: BADGE[f.level].fg, marginBottom: 6 }}>{BADGE[f.level].label}</span>
                <p style={{ fontSize: 14, margin: "0 0 6px" }}>{f.plain}</p>
                {f.who && f.who !== r.address && <p style={{ ...s.small, margin: 0 }}>Account: <span style={s.mono}>{f.who}</span></p>}
                {f.fix && <button type="button" style={{ ...s.btnGhost, marginTop: 8 }} onClick={() => fix(f)}>{FIX_LABEL[f.fix.action] ?? "Fix"}</button>}
              </div>
            ))}
            {r.notes.map((n) => <p key={n} style={s.small}>{n}</p>)}
          </>
        )}

        <div style={{ ...s.card, background: "#fbfbf9" }}>
          <p style={{ ...s.h2, fontSize: 14 }}>Good to know</p>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "#444" }}>
            <li>Since October 2026 an XRP wallet can let another account send transactions for it (&quot;permission delegation&quot;). If you never set one up and one shows here, remove it.</li>
            <li>Removing a permission or cancelling a check is a normal transaction you approve in your own wallet. It&apos;s free here; the XRP Ledger charges its usual tiny network fee.</li>
            <li>We don&apos;t change anything for you, and this isn&apos;t a security audit. We only show what the XRP Ledger says right now.</li>
          </ul>
        </div>
        <p style={s.small}>For developers and AI agents: the same check as an API (<a href="/openapi.json">OpenAPI</a>, x402 pay-per-call) and in the XRPLHub MCP server.</p>
      </main>
    </div>
  );
}

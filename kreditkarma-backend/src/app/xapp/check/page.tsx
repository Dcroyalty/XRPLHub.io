"use client";
// src/app/xapp/check/page.tsx — the WALLET CHECK xApp (runs INSIDE Xaman; console "WebApp URL" points here, 2026-10-11).
// One purpose: check before you trust.
//   1. Your wallet: who else can act on it (src/lib/walletPermissions.ts via GET /api/permissions/:address), with the free
//      fixes (POST /api/permissions/fix) — explained in plain words first, opened in Xaman only when the user taps.
//   2. Any wallet: its XRPLScore track record (GET /api/score/:address) before you pay it. Xaman's own contact / QR picker
//      (selectDestination) fills the address, so nobody has to type one.
// No push, no sign-in: the account comes from Xaman (POST /api/xapp/session resolves the one-time token server-side).
// Spend Controls lives on the website; /xapp/spend still works but nothing links to it.

import React, { useCallback, useEffect, useState } from "react";
import { API, ExtLink, LedgerBanner, SignPanel, XappFooter, applyXappTheme, readXapp, s, saveXapp, saveXappStyle, v, type Explain, type SignData, type XappState } from "../../spend/ui";

type Finding = { kind: string; level: "danger" | "warning" | "info" | "ok"; who: string | null; plain: string; detail: Record<string, unknown>; fix?: { action: string; params: Record<string, string> } };
type Report = { address: string; exists: boolean; headline: string; canMoveMoney: { who: string; how: string }[]; findings: Finding[]; notes: string[]; ledgerIndex: number | null };
type Score = {
  ledgerScore: number; grade: string; percentileLabel: string;
  details: { accountAgeDays: number; txCount: number; lifetimeTxEstimate?: number; balanceXRP: number; hasDomain: boolean; hasMultiSig: boolean; hasRegKey: boolean; trustLineCount: number };
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const BADGE: Record<Finding["level"], { label: string; bg: string; border: string; fg: string }> = {
  danger: { label: "Can take money", bg: v("danger-bg", "#fff7f6"), border: v("danger-border", "#f2b8b5"), fg: v("err", "#b91c1c") },
  warning: { label: "Check this", bg: v("warn-bg", "#fffbea"), border: v("warn-border", "#f0e3a8"), fg: v("attn", "#b45309") },
  info: { label: "Good to know", bg: v("subtle", "#f4f4f2"), border: v("border", "#e4e4e0"), fg: v("label", "#444") },
  ok: { label: "Normal", bg: v("ok-bg", "#eef8f6"), border: v("ok-border", "#99d5cc"), fg: v("ok", "#047857") },
};
const FIX_LABEL: Record<string, string> = { revoke_delegation: "Remove this permission", cancel_check: "Cancel this check" };

/** Plain words shown before the Xaman screen opens, for each free fix. */
function explainFix(f: Finding): Explain {
  const who = f.who ? short(f.who) : "this account";
  if (f.fix?.action === "revoke_delegation") return {
    what: `Remove every permission you gave ${who} to send transactions for your wallet.`,
    why: "Only keep permissions you set up yourself and still want. If you don't recognise this one, remove it.",
    consequences: [`After this, ${who} can't send anything for your wallet.`, "Nothing else changes. You can give a permission again later if you need it.", "XRPLHub doesn't charge for this."],
  };
  return {
    what: `Cancel the check that ${who} could cash from your wallet.`,
    why: "A check can be cashed by the person it's written to until it's cashed, cancelled or expires.",
    consequences: ["After this, nobody can cash this check.", "The 0.2 XRP it set aside in your wallet is free again.", "XRPLHub doesn't charge for this."],
  };
}

function age(days: number): string {
  if (days < 1) return "today";
  if (days < 31) return `${Math.round(days)} day${Math.round(days) === 1 ? "" : "s"} ago`;
  if (days < 365) return `about ${Math.round(days / 30)} month${Math.round(days / 30) === 1 ? "" : "s"} ago`;
  const y = days / 365;
  return `about ${y < 1.5 ? "1 year" : `${Math.round(y)} years`} ago`;
}

export default function WalletCheckXapp() {
  const [x, setX] = useState<XappState | null>(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<"mine" | "other">("mine");

  // Your wallet
  const [report, setReport] = useState<Report | null>(null);
  const [rErr, setRErr] = useState("");
  const [sign, setSign] = useState<{ title: string; data: SignData; explain: Explain } | null>(null);
  const [fixBusy, setFixBusy] = useState("");

  // Any wallet
  const [addr, setAddr] = useState("");
  const [score, setScore] = useState<Score | null>(null);
  const [scored, setScored] = useState("");
  const [sErr, setSErr] = useState("");
  const [sBusy, setSBusy] = useState(false);

  // 1. Session: resolve Xaman's one-time token once; follow Xaman's theme on every screen.
  useEffect(() => {
    let dead = false;
    (async () => {
      const q = new URLSearchParams(window.location.search);
      saveXappStyle(q.get("xAppStyle"));
      applyXappTheme(q.get("xAppStyle") ?? (window.sessionStorage.getItem("xrplhub_xapp_style") || "LIGHT"));
      const ott = q.get("xAppToken");
      const existing = readXapp();
      try {
        if (!ott && existing) { setX(existing); return; }
        if (!ott) { setErr("Please open Wallet Check from the xApps list in Xaman."); return; }
        const r = await fetch(`${API}/api/xapp/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ott }) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.message ?? "Could not start");
        const st: XappState = { session: j.session, account: j.account, canSign: j.canSign };
        saveXapp(st);
        if (!dead) setX(st);
      } catch (e) {
        if (existing && !dead) setX(existing); // the token was already used (e.g. a reload): keep the session we have
        else if (!dead) setErr(e instanceof Error ? e.message : "Could not start");
      } finally {
        import("xumm-xapp-sdk").then(({ xApp }) => { void new xApp().ready(); }).catch(() => {});
      }
    })();
    return () => { dead = true; };
  }, []);

  // 2. Your wallet: who else can act on it.
  const loadMine = useCallback(async (account: string) => {
    setRErr("");
    try {
      const r = await fetch(`${API}/api/permissions/${encodeURIComponent(account)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.message ?? "Couldn't read the XRP Ledger just now.");
      setReport(j);
    } catch (e) { setRErr(e instanceof Error ? e.message : "Couldn't read the XRP Ledger just now."); }
  }, []);
  useEffect(() => { if (x) void loadMine(x.account); }, [x, loadMine]); // eslint-disable-line react-hooks/set-state-in-effect

  const startFix = async (f: Finding) => {
    if (!f.fix) return;
    setFixBusy(f.plain); setRErr("");
    try {
      const r = await fetch(`${API}/api/permissions/fix`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: f.fix.action, ...f.fix.params }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message ?? "Couldn't prepare that.");
      setSign({ title: FIX_LABEL[f.fix.action] ?? "Approve in Xaman", data: j, explain: explainFix(f) });
    } catch (e) { setRErr(e instanceof Error ? e.message : "Couldn't prepare that."); }
    finally { setFixBusy(""); }
  };

  // 3. Any wallet: its track record.
  const check = async (a: string) => {
    const address = a.trim();
    if (!address) return;
    setAddr(address); setSBusy(true); setSErr(""); setScore(null); setScored(address);
    try {
      const r = await fetch(`${API}/api/score/${encodeURIComponent(address)}`);
      const j = await r.json();
      if (r.status === 404) throw new Error("This address has no history on the XRP Ledger. Nobody has ever used it. Make sure it's the right address before you send anything.");
      if (r.status === 400) throw new Error("That doesn't look like an XRP wallet address. They start with r.");
      if (!r.ok) throw new Error("Couldn't read the XRP Ledger just now. Try again in a minute.");
      setScore(j);
    } catch (e) { setSErr(e instanceof Error ? e.message : "Something went wrong."); }
    finally { setSBusy(false); }
  };
  // Xaman's own contact list / QR scanner fills the address.
  const pick = () => {
    import("xumm-xapp-sdk").then(({ xApp }) => {
      const app = new xApp();
      const on = (d: { reason: string; destination?: { address: string } }) => {
        app.off("destination", on);
        if (d.reason === "SELECTED" && d.destination?.address) void check(d.destination.address);
      };
      app.on("destination", on);
      void app.selectDestination({ ignoreDestinationTag: true });
    }).catch(() => setSErr("Xaman's contact picker didn't open. Paste the address instead."));
  };

  const tabBtn = (id: "mine" | "other", label: string) => (
    <button type="button" onClick={() => setTab(id)} style={{ ...(tab === id ? s.btn : s.btnGhost), flex: "1 1 0", padding: "10px 8px" }}>{label}</button>
  );
  const canFix = !!x?.canSign;

  return (
    <div style={s.shell}>
      <main style={{ ...s.page, paddingTop: 16 }}><LedgerBanner />
        <h1 style={s.h1}>Wallet Check</h1>
        <p style={s.sub}>Check before you trust. See who else can move money from your wallet, and look up any wallet&apos;s track record before you pay it. Free. Nothing is changed unless you approve it.</p>
        {err && <p style={s.err}>{err}</p>}

        {x && (
          <>
            <div style={{ display: "flex", gap: 8, margin: "0 0 14px" }}>
              {tabBtn("mine", "Your wallet")}
              {tabBtn("other", "Check a wallet")}
            </div>

            {tab === "mine" && (
              <>
                <p style={{ ...s.small, marginTop: 0 }}>Account <span style={s.mono}>{x.account}</span>{!x.canSign && " · read-only in Xaman: you can look, but not approve fixes"}</p>
                {sign && <SignPanel data={sign.data} title={sign.title} explain={sign.explain} onDone={() => { setSign(null); void loadMine(x.account); }} />}
                {rErr && <p style={s.err}>{rErr}</p>}
                {!report && !rErr && <p style={s.small}>Reading your wallet from the XRP Ledger…</p>}
                {report && (
                  <>
                    <div style={{ ...s.card, background: report.canMoveMoney.length ? v("danger-bg", "#fff7f6") : v("ok-bg", "#eef8f6"), borderColor: report.canMoveMoney.length ? v("danger-border", "#f2b8b5") : v("ok-border", "#99d5cc") }}>
                      <p style={{ ...s.h2, fontSize: 17 }}>{report.headline}</p>
                      {report.canMoveMoney.length > 0 && (
                        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14 }}>
                          {report.canMoveMoney.map((m) => <li key={m.who + m.how} style={{ margin: "3px 0" }}><span style={s.mono}>{short(m.who)}</span>: {m.how}</li>)}
                        </ul>
                      )}
                      <p style={{ ...s.small, margin: "8px 0 0" }}>Read from the XRP Ledger just now{report.ledgerIndex ? ` (ledger ${report.ledgerIndex.toLocaleString()})` : ""}.</p>
                    </div>
                    {report.findings.map((f, i) => (
                      <div key={i} style={{ ...s.card, background: BADGE[f.level].bg, borderColor: BADGE[f.level].border }}>
                        <span style={{ display: "inline-block", fontSize: 12, fontWeight: 700, color: BADGE[f.level].fg, marginBottom: 4 }}>{BADGE[f.level].label}</span>
                        <p style={{ fontSize: 14, margin: 0 }}>{f.plain}</p>
                        {f.fix && canFix && (
                          <button type="button" style={{ ...s.btnGhost, width: "100%", marginTop: 10 }} disabled={!!fixBusy} onClick={() => void startFix(f)}>
                            {fixBusy === f.plain ? "Preparing…" : `${FIX_LABEL[f.fix.action] ?? "Fix this"} (free)`}
                          </button>
                        )}
                      </div>
                    ))}
                    {report.notes.map((n) => <p key={n} style={s.small}>{n}</p>)}
                    <button type="button" style={{ ...s.btnGhost, width: "100%" }} onClick={() => void loadMine(x.account)}>Check again</button>
                    <button type="button" style={{ ...s.btnGhost, width: "100%", marginTop: 8 }} onClick={() => { setTab("other"); void check(x.account); }}>See my own track record</button>
                  </>
                )}
              </>
            )}

            {tab === "other" && (
              <>
                <p style={{ ...s.small, marginTop: 0 }}>About to pay someone? Look up their wallet first. You&apos;ll see how long it has been used and how active it is.</p>
                <button type="button" style={{ ...s.btn, width: "100%", padding: "12px 16px" }} onClick={pick}>Choose a contact or scan a QR code</button>
                <p style={{ ...s.small, margin: "10px 0 6px" }}>Or paste an address:</p>
                <div style={{ display: "flex", gap: 8 }}>
                  <input style={{ ...s.input, ...s.mono, flex: "1 1 auto", minWidth: 0 }} value={addr} onChange={(e) => setAddr(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void check(addr)} placeholder="r…" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
                  <button type="button" style={s.btn} disabled={sBusy} onClick={() => void check(addr)}>{sBusy ? "…" : "Check"}</button>
                </div>
                {sBusy && <p style={s.small}>Reading the XRP Ledger…</p>}
                {sErr && <p style={s.err}>{sErr}</p>}
                {score && (
                  <div style={s.card}>
                    <p style={{ ...s.small, margin: 0 }}>Track record of <span style={s.mono}>{short(scored)}</span>{scored === x.account ? " (your wallet)" : ""}</p>
                    <p style={{ fontSize: 40, fontWeight: 800, margin: "4px 0 0", lineHeight: 1.1 }}>{score.ledgerScore}<span style={{ fontSize: 15, fontWeight: 600, color: v("muted", "#555") }}> / 850 · {score.grade}</span></p>
                    <p style={{ ...s.small, margin: "2px 0 10px" }}>{score.percentileLabel}.</p>
                    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14 }}>
                      <li style={{ margin: "3px 0" }}>First used {age(score.details.accountAgeDays)}</li>
                      <li style={{ margin: "3px 0" }}>{(score.details.lifetimeTxEstimate ?? score.details.txCount).toLocaleString()} transactions so far</li>
                      <li style={{ margin: "3px 0" }}>Holds {score.details.balanceXRP.toLocaleString()} XRP right now</li>
                      {score.details.hasDomain && <li style={{ margin: "3px 0" }}>Has a website (domain) linked to it</li>}
                    </ul>
                    <p style={{ fontSize: 13, margin: "12px 0 0", color: v("fg", "#333") }}>
                      What this means: a wallet that has been used for longer, and more steadily, scores higher. A low score isn&apos;t proof of a scam,
                      and a high score isn&apos;t proof someone is honest. Use it as one check before you pay.
                    </p>
                    <p style={{ ...s.small, margin: "8px 0 0" }}>XRPLScore uses only public XRP Ledger activity. It is not a credit score and must not be used to decide credit, a job, housing or insurance.</p>
                    <p style={{ ...s.small, margin: "6px 0 0" }}><ExtLink href="https://www.xrplhub.io/#score" style={{ color: v("accent", "#0f766e") }}>How the score works</ExtLink></p>
                  </div>
                )}
              </>
            )}
          </>
        )}
        {!x && !err && <p style={s.small}>Opening…</p>}
        <p style={{ ...s.small, marginTop: 16 }}>XRPLHub only reads the public XRP Ledger. It never holds your money or keys, and never asks for your secret or recovery words.</p>
        <XappFooter />
      </main>
    </div>
  );
}

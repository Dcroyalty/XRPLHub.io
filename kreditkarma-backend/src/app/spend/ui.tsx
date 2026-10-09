"use client";
// src/app/spend/ui.tsx — shared bits for the Spend Controls pages (light pages, like /checkout).

import React, { useEffect, useState } from "react";
import { watchXaman } from "@/lib/wallet/xamanWatch";

export const API = (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_API_URL) || "";

export const s: Record<string, React.CSSProperties> = {
  shell: { background: "#f7f7f5", color: "#1a1a1a", minHeight: "100vh" },
  page: { maxWidth: 760, margin: "0 auto", padding: "28px 16px 56px", fontFamily: "system-ui, -apple-system, sans-serif", lineHeight: 1.5 },
  h1: { fontSize: 26, fontWeight: 800, margin: "4px 0 6px" },
  h2: { fontSize: 17, fontWeight: 700, margin: "0 0 10px" },
  sub: { color: "#555", fontSize: 14, margin: "0 0 18px" },
  card: { background: "#fff", border: "1px solid #e4e4e0", borderRadius: 12, padding: 16, marginBottom: 14 },
  label: { display: "block", fontSize: 12, fontWeight: 600, color: "#444", margin: "0 0 4px" },
  input: { width: "100%", padding: "9px 10px", border: "1px solid #ccc", borderRadius: 8, fontSize: 14, boxSizing: "border-box", background: "#fff", color: "#1a1a1a" },
  mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, wordBreak: "break-all" },
  btn: { padding: "10px 16px", borderRadius: 9, border: "none", background: "#0f766e", color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer" },
  btnGhost: { padding: "8px 12px", borderRadius: 8, border: "1px solid #ccc", background: "#fff", color: "#1a1a1a", fontSize: 13, cursor: "pointer" },
  small: { fontSize: 12, color: "#666" },
  err: { color: "#b91c1c", fontSize: 13, margin: "6px 0" },
  ok: { color: "#047857", fontSize: 13, margin: "6px 0" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "6px 6px", borderBottom: "1px solid #e4e4e0", color: "#555", fontWeight: 600 },
  td: { padding: "7px 6px", borderBottom: "1px solid #f0f0ec", verticalAlign: "top" },
};

export function Disclosure({ lines }: { lines?: string[] }) {
  if (!lines?.length) return null;
  return (
    <div style={{ ...s.card, background: "#fffbea", borderColor: "#f0e3a8" }}>
      <p style={{ ...s.h2, fontSize: 14 }}>Read this first</p>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "#4a4a3a" }}>
        {lines.map((l) => <li key={l} style={{ margin: "3px 0" }}>{l}</li>)}
      </ul>
    </div>
  );
}

export type SignData = { uuid?: string | null; qr_png?: string | null; deep_link?: string | null; websocket?: string | null; txjson?: Record<string, unknown> };

// ── xApp mode: these pages running INSIDE Xaman as the Spend Controls xApp (src/app/xapp/spend) ──────────────────────
const XAPP_KEY = "xrplhub_xapp";
export type XappState = { session: string; account: string; canSign: boolean };
export function readXapp(): XappState | null {
  try {
    const raw = typeof window !== "undefined" ? window.sessionStorage.getItem(XAPP_KEY) : null;
    return raw ? (JSON.parse(raw) as XappState) : null;
  } catch {
    return null;
  }
}
export function saveXapp(x: XappState) {
  try { window.sessionStorage.setItem(XAPP_KEY, JSON.stringify(x)); } catch { /* the xApp still works for this page */ }
}
/** null until mounted (SSR-safe), then the xApp session or false. */
export function useXapp(): XappState | false | null {
  const [x, setX] = useState<XappState | false | null>(null);
  useEffect(() => { setX(readXapp() ?? false); }, []); // eslint-disable-line react-hooks/set-state-in-effect
  return x;
}

/** Inside Xaman: open the sign request with the xApp SDK (an in-app overlay, no QR, no deep link) and wait for its
 *  `payload` event. XRPLHub created the payload server-side with the same Xaman app; the user signs in Xaman. */
function XappSignPanel({ data, title, onDone, onSigned }: { data: SignData; title: string; onDone?: () => void; onSigned?: (uuid: string) => void; approveOnly?: boolean }) {
  const [state, setState] = useState<"opening" | "waiting" | "signed" | "rejected" | "error">("opening");
  const [sdk, setSdk] = useState<{ openSignRequest: (o: { uuid: string }) => unknown } | null>(null);
  useEffect(() => {
    if (!data.uuid) return;
    const uuid = data.uuid;
    let dead = false;
    let off: (() => void) | null = null;
    import("xumm-xapp-sdk").then(({ xApp }) => {
      if (dead) return;
      const x = new xApp();
      const onPayload = (e: { reason: "SIGNED" | "DECLINED"; uuid: string }) => {
        if (e.uuid !== uuid) return;
        if (e.reason === "SIGNED") { setState("signed"); onSigned?.(uuid); setTimeout(() => onDone?.(), 3000); }
        else setState("rejected");
      };
      x.on("payload", onPayload);
      off = () => x.off("payload", onPayload);
      setSdk(x as unknown as { openSignRequest: (o: { uuid: string }) => unknown });
      x.openSignRequest({ uuid });
      setState("waiting");
    }).catch(() => setState("error"));
    return () => { dead = true; off?.(); };
  }, [data.uuid]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div style={{ ...s.card, borderColor: "#99d5cc" }}>
      <p style={s.h2}>{title}</p>
      {!data.uuid && <p style={s.err}>Xaman could not create this sign request just now. Try again in a moment.</p>}
      {data.uuid && state === "opening" && <p style={s.small}>Opening the sign request in Xaman…</p>}
      {data.uuid && state === "waiting" && (
        <p style={s.small}>Review and sign it in the Xaman overlay. {sdk && <button type="button" style={s.btnGhost} onClick={() => sdk.openSignRequest({ uuid: data.uuid! })}>Open it again</button>}</p>
      )}
      {state === "signed" && <p style={s.ok}>Signed — updating from the ledger…</p>}
      {state === "rejected" && <p style={s.err}>Declined. Nothing was sent.</p>}
      {state === "error" && <p style={s.err}>The Xaman xApp bridge didn&apos;t load. Close and reopen the xApp.</p>}
      <p style={{ ...s.small, marginTop: 8 }}>You sign in your own wallet. XRPLHub never holds keys or funds.</p>
    </div>
  );
}

/** Shows how to sign: Xaman QR / deep link, or the raw transaction for any other wallet. XRPLHub never signs.
 *  Inside the Xaman xApp it hands off to XappSignPanel (SDK sign requests). */
/** approveOnly: an Autopay pre-approval (Xaman signs WITHOUT sending). Never offer its raw transaction to another
 *  wallet — most wallets would send it at once, i.e. pay early. */
export function SignPanel(props: { data: SignData; title: string; onDone?: () => void; onSigned?: (uuid: string) => void; approveOnly?: boolean }) {
  const x = useXapp();
  if (x) return <XappSignPanel {...props} />;
  if (x === null) return null;
  return <WebSignPanel {...props} />;
}

function WebSignPanel({ data, title, onDone, onSigned, approveOnly }: { data: SignData; title: string; onDone?: () => void; onSigned?: (uuid: string) => void; approveOnly?: boolean }) {
  const [showJson, setShowJson] = useState(!approveOnly && !data.qr_png && !data.deep_link);
  const [state, setState] = useState<"waiting" | "signed" | "rejected" | "expired">("waiting");
  // Xaman pushes the result over its status websocket (no polling). On a signature, tell the caller (which records the
  // push token for subscriptions) and refresh from the ledger.
  useEffect(() => {
    if (!data.uuid) return;
    const uuid = data.uuid;
    const w = watchXaman(uuid, (r) => {
      if (r.signed) { setState("signed"); onSigned?.(uuid); setTimeout(() => onDone?.(), 4000); }
      else if (r.expired) setState("expired");
      else setState("rejected");
    }, data.websocket);
    return () => w.stop();
  }, [data.uuid, data.websocket]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div style={{ ...s.card, borderColor: "#99d5cc" }}>
      <p style={s.h2}>{title}</p>
      {data.qr_png && <img src={data.qr_png} alt="Scan with Xaman to sign" style={{ width: 180, height: 180, display: "block", margin: "0 auto 8px" }} />}
      {data.deep_link && <p style={{ textAlign: "center", margin: "4px 0 10px" }}><a href={data.deep_link} target="_blank" rel="noreferrer">Open in Xaman →</a></p>}
      {approveOnly
        ? <p style={s.small}>Approve this in Xaman only. Approving does not send it: XRPLHub sends it at the start of its week or month.</p>
        : <button type="button" style={s.btnGhost} onClick={() => setShowJson((v) => !v)}>{showJson ? "Hide" : "Show"} the transaction (to sign in another wallet)</button>}
      {!approveOnly && showJson && data.txjson && <pre style={{ ...s.mono, background: "#f4f4f2", padding: 10, borderRadius: 8, marginTop: 8, whiteSpace: "pre-wrap" }}>{JSON.stringify(data.txjson, null, 2)}</pre>}
      {state === "signed" && <p style={s.ok}>{approveOnly ? "Approved in Xaman. Nothing was sent." : "Signed in Xaman — updating from the ledger…"}</p>}
      {state === "rejected" && <p style={s.err}>Rejected in Xaman. Nothing was sent.</p>}
      {state === "expired" && <p style={s.err}>This sign request expired. Start again.</p>}
      <p style={{ ...s.small, marginTop: 8 }}>You sign in your own wallet. XRPLHub never holds keys or funds.</p>
      {onDone && <button type="button" style={{ ...s.btn, marginTop: 6 }} onClick={onDone}>I signed it — refresh</button>}
    </div>
  );
}

export const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

// ── Sign in with Xaman (no transaction, no funds move) — the same SignIn flow as the homepage ───────────────────────
// Proves which wallet is yours so no page asks you to type your own address. The verified address is remembered in
// localStorage "xh_wallet" (shared with the homepage). Inside the Xaman xApp, the xApp session's account is used.
const WALLET_KEY = "xh_wallet";
export function readSavedWallet(): string | null {
  try { const w = window.localStorage.getItem(WALLET_KEY); return w && /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(w) ? w : null; } catch { return null; }
}
/** null until mounted; then the signed-in wallet (xApp account first) or "" when nobody is signed in. */
export function useSignedInWallet(): [string | null, (w: string | null) => void] {
  const xapp = useXapp();
  const [w, setW] = useState<string | null>(null);
  useEffect(() => {
    if (xapp === null) return;
    setW(xapp ? xapp.account : (readSavedWallet() ?? "")); // eslint-disable-line react-hooks/set-state-in-effect
  }, [xapp]);
  const set = (v: string | null) => {
    try { if (v) window.localStorage.setItem(WALLET_KEY, v); else window.localStorage.removeItem(WALLET_KEY); } catch { /* fine */ }
    setW(v ?? "");
  };
  return [w, set];
}

export function ConnectXaman({ wallet, onChange, purpose }: { wallet: string | null; onChange: (w: string | null) => void; purpose: string }) {
  const xapp = useXapp();
  const [req, setReq] = useState<{ uuid: string; qr_png: string; deep_link: string } | null>(null);
  const [state, setState] = useState<"idle" | "creating" | "waiting" | "error">("idle");
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!req) return;
    let stop = false;
    const check = async () => {
      try {
        const r = await fetch(`${API}/api/check-wallet?uuid=${req.uuid}`);
        const d = await r.json();
        if (stop) return;
        if (d.status === "connected" && d.address) { onChange(d.address); setReq(null); setState("idle"); }
        else if (d.status === "expired" || d.status === "rejected") { setReq(null); setState("error"); setErr(d.status === "expired" ? "That sign-in expired. Try again." : "You declined it in Xaman."); }
      } catch { /* the watcher will retry */ }
    };
    // The status websocket resolves it; REST is only the slow fallback (xw.delay(): 45 s with a healthy socket, 15 s without).
    let t: ReturnType<typeof setTimeout> | null = null;
    const loop = async () => { await check(); if (!stop) t = setTimeout(loop, xw.delay()); };
    const xw = watchXaman(req.uuid, () => { if (t) clearTimeout(t); void check(); });
    t = setTimeout(loop, xw.delay());
    return () => { stop = true; xw.stop(); if (t) clearTimeout(t); };
  }, [req]); // eslint-disable-line react-hooks/exhaustive-deps

  if (wallet === null) return null;
  if (wallet) {
    return (
      <div style={{ ...s.card, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", background: "#f2fbf8", borderColor: "#99d5cc" }}>
        <span style={{ fontSize: 14 }}>Signed in with <strong>{wallet.slice(0, 6)}…{wallet.slice(-4)}</strong> <span style={s.small}>({purpose})</span></span>
        {!xapp && <button type="button" style={s.btnGhost} onClick={() => onChange(null)}>Use a different wallet</button>}
      </div>
    );
  }
  const start = async () => {
    setState("creating"); setErr("");
    try {
      const r = await fetch(`${API}/api/connect-wallet`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const d = await r.json();
      if (!r.ok || !d.uuid) throw new Error(d.error ?? "Couldn't reach Xaman.");
      setReq(d); setState("waiting");
    } catch (e) { setState("error"); setErr(e instanceof Error ? e.message : "Couldn't reach Xaman."); }
  };
  return (
    <div style={{ ...s.card, borderColor: "#99d5cc" }}>
      <p style={{ ...s.h2, fontSize: 15 }}>First, sign in with Xaman</p>
      <p style={{ ...s.small, marginTop: -4 }}>So you don&apos;t have to type your wallet address ({purpose}). Signing in sends nothing and moves no money.</p>
      {state !== "waiting" && <button type="button" style={s.btn} disabled={state === "creating"} onClick={start}>{state === "creating" ? "Opening Xaman…" : "Sign in with Xaman →"}</button>}
      {state === "waiting" && req && (
        <div style={{ textAlign: "center" }}>
          <img src={req.qr_png} alt="Scan with Xaman to sign in" style={{ width: 170, height: 170, display: "block", margin: "4px auto 6px" }} />
          <a href={req.deep_link} target="_blank" rel="noreferrer">Open in Xaman →</a>
          <p style={s.small}>Waiting for you to approve the sign-in in Xaman…</p>
        </div>
      )}
      {err && <p style={s.err}>{err}</p>}
    </div>
  );
}

"use client";
// src/app/spend/ui.tsx — shared bits for the Spend Controls pages (light pages, like /checkout).
// Colors are CSS variables whose FALLBACK is the website's light palette, so on the website nothing changes. Inside
// the Xaman xApp, applyXappTheme() sets the variables to follow Xaman's theme (xAppStyle: LIGHT / DARK / MOONLIGHT /
// ROYAL). Use v("name", "#fallback") for any new color on a page the xApp can reach.

import React, { useEffect, useRef, useState } from "react";
import { watchXaman } from "@/lib/wallet/xamanWatch";

export const API = (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_API_URL) || "";

/** A themeable color: the website's value as the fallback, the xApp theme's value when one is set. */
export const v = (name: string, fallback: string) => `var(--xh-${name}, ${fallback})`;

export const s: Record<string, React.CSSProperties> = {
  shell: { background: v("bg", "#f7f7f5"), color: v("fg", "#1a1a1a"), minHeight: "100vh" },
  page: { maxWidth: 760, margin: "0 auto", padding: "28px 16px 56px", fontFamily: "system-ui, -apple-system, sans-serif", lineHeight: 1.5 },
  h1: { fontSize: 26, fontWeight: 800, margin: "4px 0 6px" },
  h2: { fontSize: 17, fontWeight: 700, margin: "0 0 10px" },
  sub: { color: v("muted", "#555"), fontSize: 14, margin: "0 0 18px" },
  card: { background: v("card", "#fff"), border: `1px solid ${v("border", "#e4e4e0")}`, borderRadius: 12, padding: 16, marginBottom: 14 },
  label: { display: "block", fontSize: 12, fontWeight: 600, color: v("label", "#444"), margin: "0 0 4px" },
  input: { width: "100%", padding: "9px 10px", border: `1px solid ${v("input-border", "#ccc")}`, borderRadius: 8, fontSize: 14, boxSizing: "border-box", background: v("input-bg", "#fff"), color: v("fg", "#1a1a1a") },
  mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, wordBreak: "break-all" },
  btn: { padding: "10px 16px", borderRadius: 9, border: "none", background: v("accent", "#0f766e"), color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer" },
  btnGhost: { padding: "8px 12px", borderRadius: 8, border: `1px solid ${v("input-border", "#ccc")}`, background: v("card", "#fff"), color: v("fg", "#1a1a1a"), fontSize: 13, cursor: "pointer" },
  small: { fontSize: 12, color: v("small", "#666") },
  err: { color: v("err", "#b91c1c"), fontSize: 13, margin: "6px 0" },
  ok: { color: v("ok", "#047857"), fontSize: 13, margin: "6px 0" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "6px 6px", borderBottom: `1px solid ${v("border", "#e4e4e0")}`, color: v("muted", "#555"), fontWeight: 600 },
  td: { padding: "7px 6px", borderBottom: `1px solid ${v("row", "#f0f0ec")}`, verticalAlign: "top" },
};

export function Disclosure({ lines }: { lines?: string[] }) {
  if (!lines?.length) return null;
  return (
    <div style={{ ...s.card, background: v("warn-bg", "#fffbea"), borderColor: v("warn-border", "#f0e3a8") }}>
      <p style={{ ...s.h2, fontSize: 14 }}>Read this first</p>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: v("warn-fg", "#4a4a3a") }}>
        {lines.map((l) => <li key={l} style={{ margin: "3px 0" }}>{l}</li>)}
      </ul>
    </div>
  );
}

export type SignData = { uuid?: string | null; qr_png?: string | null; deep_link?: string | null; websocket?: string | null; txjson?: Record<string, unknown> };
/** What the user is about to sign, in plain words — shown BEFORE every signature inside the xApp. */
export type Explain = { what: string; why: string; consequences: string[] };

// ── xApp mode: these pages running INSIDE Xaman as the Spend Controls xApp (src/app/xapp/spend) ──────────────────────
const XAPP_KEY = "xrplhub_xapp";
const XAPP_STYLE_KEY = "xrplhub_xapp_style";
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
/** True inside Xaman's xApp webview, even if the session were lost: xApps run in a React Native WebView. */
export function inXamanWebview(): boolean {
  if (typeof window === "undefined") return false;
  return typeof (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView !== "undefined" || readXapp() !== null;
}
/** null until mounted (SSR-safe), then the xApp session or false. Applies Xaman's theme while in the xApp. */
export function useXapp(): XappState | false | null {
  const [x, setX] = useState<XappState | false | null>(null);
  useEffect(() => {
    const st = readXapp();
    if (st) applyXappTheme(readXappStyle());
    setX(st ?? false); // eslint-disable-line react-hooks/set-state-in-effect
  }, []);
  return x;
}

// Xaman passes its theme as ?xAppStyle=LIGHT|DARK|MOONLIGHT|ROYAL when it opens the xApp; we keep it for the session.
type Theme = Record<string, string>;
const LIGHT: Theme = {
  bg: "#f7f7f5", fg: "#1a1a1a", card: "#ffffff", border: "#e4e4e0", muted: "#555555", label: "#444444", small: "#666666",
  "input-bg": "#ffffff", "input-border": "#cccccc", accent: "#0f766e", err: "#b91c1c", ok: "#047857", row: "#f0f0ec",
  "warn-bg": "#fffbea", "warn-border": "#f0e3a8", "warn-fg": "#4a4a3a", "ok-bg": "#eef8f6", "ok-border": "#99d5cc",
  subtle: "#f4f4f2", "danger-bg": "#fff7f6", "danger-border": "#f2b8b5", "attn": "#b45309",
};
const dark = (bg: string, card: string, border: string): Theme => ({
  bg, fg: "#f2f2f2", card, border, muted: "#b8bcc6", label: "#c8ccd4", small: "#9aa0ab",
  "input-bg": card, "input-border": border, accent: "#14b8a6", err: "#f87171", ok: "#34d399", row: border,
  "warn-bg": "#2b2410", "warn-border": "#5c4a12", "warn-fg": "#f1e6c2", "ok-bg": "#0f2a26", "ok-border": "#1f6b5f",
  subtle: card, "danger-bg": "#2d1414", "danger-border": "#6b2424", attn: "#fbbf24",
});
const THEMES: Record<string, Theme> = {
  LIGHT,
  DARK: dark("#000000", "#1c1c1e", "#2c2c2e"),
  MOONLIGHT: dark("#181a21", "#23262f", "#343845"),
  ROYAL: dark("#030b36", "#0d1a4f", "#1f2d6b"),
};
export function saveXappStyle(style: string | null) {
  try { if (style) window.sessionStorage.setItem(XAPP_STYLE_KEY, style.toUpperCase()); } catch { /* fine */ }
}
function readXappStyle(): string {
  try { return window.sessionStorage.getItem(XAPP_STYLE_KEY) ?? "LIGHT"; } catch { return "LIGHT"; }
}
export function applyXappTheme(style: string) {
  const t = THEMES[style.toUpperCase()] ?? LIGHT;
  const root = document.documentElement;
  for (const [k, val] of Object.entries(t)) root.style.setProperty(`--xh-${k}`, val);
  root.style.background = t.bg;
  document.body.style.background = t.bg;
  root.style.colorScheme = t === LIGHT ? "light" : "dark";
}

/** A link to somewhere outside the xApp (XRPScan, Privacy, Terms): opened in Xaman's in-app browser inside the xApp,
 *  a normal new tab on the website. */
export function ExtLink({ href, children, style }: { href: string; children: React.ReactNode; style?: React.CSSProperties }) {
  const open = (e: React.MouseEvent) => {
    if (!inXamanWebview()) return;
    e.preventDefault();
    import("xumm-xapp-sdk").then(({ xApp }) => { void new xApp().openBrowser({ url: href }); }).catch(() => { window.location.href = href; });
  };
  return <a href={href} target="_blank" rel="noreferrer" onClick={open} style={style}>{children}</a>;
}

/** Support, legal and independence — at the bottom of every xApp screen (Xaman's xApp review checklist). */
export function XappFooter() {
  return (
    <div style={{ borderTop: `1px solid ${v("border", "#e4e4e0")}`, marginTop: 22, paddingTop: 12, fontSize: 12, color: v("small", "#666"), lineHeight: 1.7 }}>
      <div>
        Help: <a href="mailto:support@xrplhub.io" style={{ color: v("accent", "#0f766e") }}>support@xrplhub.io</a>
        {" · "}<ExtLink href="https://www.xrplhub.io/privacy" style={{ color: v("accent", "#0f766e") }}>Privacy Policy</ExtLink>
        {" · "}<ExtLink href="https://www.xrplhub.io/terms" style={{ color: v("accent", "#0f766e") }}>Terms</ExtLink>
      </div>
      <div>XRPLHub is an independent service. It is not affiliated with, endorsed by or operated by XRPL Labs or Xaman.</div>
    </div>
  );
}

const feeText = (tx?: Record<string, unknown>) => {
  const f = tx && typeof tx.Fee === "string" ? Number(tx.Fee) : null;
  return f ? `${f / 1e6} XRP network fee (paid to the XRP Ledger, not to XRPLHub).` : "A tiny network fee, about 0.000012 XRP, set by Xaman and paid to the XRP Ledger (not to XRPLHub).";
};

/** Inside Xaman: FIRST explain what is being signed (what, why, fee, consequences), THEN open the sign request with the
 *  xApp SDK only when the user taps. Nothing opens on its own. XRPLHub created the payload server-side; the user signs. */
function XappSignPanel({ data, title, onDone, onSigned, approveOnly, explain }: { data: SignData; title: string; onDone?: () => void; onSigned?: (uuid: string) => void; approveOnly?: boolean; explain?: Explain }) {
  const [state, setState] = useState<"review" | "waiting" | "signed" | "rejected" | "error">("review");
  const [sdk, setSdk] = useState<{ openSignRequest: (o: { uuid: string }) => unknown } | null>(null);
  const x = readXapp();
  // The panel can mount far above the button that was tapped: bring the explanation into view.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }, [data.uuid]);
  useEffect(() => {
    if (!data.uuid) return;
    const uuid = data.uuid;
    let dead = false;
    let off: (() => void) | null = null;
    import("xumm-xapp-sdk").then(({ xApp }) => {
      if (dead) return;
      const app = new xApp();
      const onPayload = (e: { reason: "SIGNED" | "DECLINED"; uuid: string }) => {
        if (e.uuid !== uuid) return;
        if (e.reason === "SIGNED") { setState("signed"); onSigned?.(uuid); setTimeout(() => onDone?.(), 3000); }
        else setState("rejected");
      };
      app.on("payload", onPayload);
      off = () => app.off("payload", onPayload);
      setSdk(app as unknown as { openSignRequest: (o: { uuid: string }) => unknown });
    }).catch(() => setState("error"));
    return () => { dead = true; off?.(); };
  }, [data.uuid]); // eslint-disable-line react-hooks/exhaustive-deps
  const open = () => { if (sdk && data.uuid) { sdk.openSignRequest({ uuid: data.uuid }); setState("waiting"); } };
  return (
    <div ref={box} style={{ ...s.card, borderColor: v("ok-border", "#99d5cc"), scrollMarginTop: 12 }}>
      <p style={s.h2}>{title}</p>
      {explain && (
        <div style={{ fontSize: 14, marginBottom: 10 }}>
          <p style={{ margin: "0 0 6px" }}><strong>What you&apos;re approving:</strong> {explain.what}</p>
          <p style={{ margin: "0 0 6px" }}><strong>Why:</strong> {explain.why}</p>
          <p style={{ margin: "0 0 6px" }}><strong>Fee:</strong> {feeText(data.txjson)}</p>
          <p style={{ margin: "0 0 4px" }}><strong>What happens after:</strong></p>
          <ul style={{ margin: 0, paddingLeft: 18 }}>{explain.consequences.map((c) => <li key={c} style={{ margin: "2px 0" }}>{c}</li>)}</ul>
        </div>
      )}
      {!data.uuid && <p style={s.err}>Xaman could not create this request just now. Go back and try again in a moment.</p>}
      {data.uuid && x && !x.canSign && <p style={s.err}>This account is read-only in Xaman, so it can&apos;t approve anything. Open the xApp from an account with its secret on this device.</p>}
      {data.uuid && (!x || x.canSign) && (state === "review" || state === "waiting") && (
        <button type="button" style={{ ...s.btn, width: "100%", padding: "13px 16px", opacity: sdk ? 1 : 0.6 }} disabled={!sdk} onClick={open}>
          {state === "waiting" ? "Open it again in Xaman" : approveOnly ? "Review and approve in Xaman (nothing is sent now)" : "Review and approve in Xaman"}
        </button>
      )}
      {state === "waiting" && <p style={{ ...s.small, marginTop: 6 }}>Check the details in the Xaman screen, then approve or decline.</p>}
      {state === "signed" && <p style={s.ok}>{approveOnly ? "Approved. Nothing was sent now." : "Approved — updating from the XRP Ledger…"}</p>}
      {state === "rejected" && <p style={s.err}>Declined. Nothing was sent.</p>}
      {state === "error" && <p style={s.err}>Xaman&apos;s xApp bridge didn&apos;t load. Close and reopen the xApp.</p>}
      <p style={{ ...s.small, marginTop: 8 }}>You approve in your own wallet. XRPLHub never holds your keys or money, and never asks for your secret or recovery words.</p>
    </div>
  );
}

/** Shows how to sign: Xaman QR / deep link, or the raw transaction for any other wallet. XRPLHub never signs.
 *  Inside the Xaman xApp it hands off to XappSignPanel (SDK sign requests). */
/** approveOnly: an Autopay pre-approval (Xaman signs WITHOUT sending). Never offer its raw transaction to another
 *  wallet — most wallets would send it at once, i.e. pay early. */
export function SignPanel(props: { data: SignData; title: string; onDone?: () => void; onSigned?: (uuid: string) => void; approveOnly?: boolean; explain?: Explain }) {
  const x = useXapp();
  if (x) return <XappSignPanel {...props} />;
  if (x === null) return null;
  return <WebSignPanel {...props} />;
}

function WebSignPanel({ data, title, onDone, onSigned, approveOnly }: { data: SignData; title: string; onDone?: () => void; onSigned?: (uuid: string) => void; approveOnly?: boolean; explain?: Explain }) {
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
  // Inside Xaman the account comes from the xApp OTT only — never a sign-in/connect/disconnect UI (xApp review rule).
  if (xapp || inXamanWebview()) return null;
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

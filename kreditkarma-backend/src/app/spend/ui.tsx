"use client";
// src/app/spend/ui.tsx — shared bits for the Spend Controls pages (light pages, like /checkout).

import React, { useState } from "react";

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

export type SignData = { uuid?: string | null; qr_png?: string | null; deep_link?: string | null; txjson?: Record<string, unknown> };

/** Shows how to sign: Xaman QR / deep link, or the raw transaction for any other wallet. XRPLHub never signs. */
export function SignPanel({ data, title, onDone }: { data: SignData; title: string; onDone?: () => void }) {
  const [showJson, setShowJson] = useState(!data.qr_png && !data.deep_link);
  return (
    <div style={{ ...s.card, borderColor: "#99d5cc" }}>
      <p style={s.h2}>{title}</p>
      {data.qr_png && <img src={data.qr_png} alt="Scan with Xaman to sign" style={{ width: 180, height: 180, display: "block", margin: "0 auto 8px" }} />}
      {data.deep_link && <p style={{ textAlign: "center", margin: "4px 0 10px" }}><a href={data.deep_link} target="_blank" rel="noreferrer">Open in Xaman →</a></p>}
      <button type="button" style={s.btnGhost} onClick={() => setShowJson((v) => !v)}>{showJson ? "Hide" : "Show"} the transaction (to sign in another wallet)</button>
      {showJson && data.txjson && <pre style={{ ...s.mono, background: "#f4f4f2", padding: 10, borderRadius: 8, marginTop: 8, whiteSpace: "pre-wrap" }}>{JSON.stringify(data.txjson, null, 2)}</pre>}
      <p style={{ ...s.small, marginTop: 8 }}>You sign in your own wallet. XRPLHub never holds keys or funds.</p>
      {onDone && <button type="button" style={{ ...s.btn, marginTop: 6 }} onClick={onDone}>I signed it — refresh</button>}
    </div>
  );
}

export const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

// src/app/lending/ui.ts — shared styles for the /lending pages (server-safe: no "use client").
// Same look as the newer XRPLHub tool pages (src/app/spend/ui.tsx): light, one column, mobile-first.
import type React from "react";

export const C = {
  bg: "#f7f7f5",
  fg: "#1a1a1a",
  muted: "#555",
  small: "#666",
  card: "#fff",
  border: "#e4e4e0",
  row: "#f0f0ec",
  accent: "#0f766e",
  yes: "#047857",
  no: "#b91c1c",
  warnBg: "#fffbea",
  warnBorder: "#f0e3a8",
};

export const L: Record<string, React.CSSProperties> = {
  shell: { background: C.bg, color: C.fg, minHeight: "100vh" },
  page: { maxWidth: 760, margin: "0 auto", padding: "20px 16px 56px", fontFamily: "system-ui, -apple-system, sans-serif", lineHeight: 1.5 },
  nav: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 18, fontSize: 14 },
  h1: { fontSize: 26, fontWeight: 800, margin: "4px 0 6px", lineHeight: 1.2 },
  h2: { fontSize: 18, fontWeight: 700, margin: "0 0 10px" },
  sub: { color: C.muted, fontSize: 15, margin: "0 0 18px" },
  card: { background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, marginBottom: 14 },
  small: { fontSize: 12, color: C.small },
  mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, wordBreak: "break-all" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "6px 6px", borderBottom: `1px solid ${C.border}`, color: C.muted, fontWeight: 600 },
  td: { padding: "7px 6px", borderBottom: `1px solid ${C.row}`, verticalAlign: "top" },
  link: { color: C.accent, fontWeight: 600, textDecoration: "none" },
};

export const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—";
export const fmtTime = (iso: string | null | undefined) =>
  iso ? `${new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: false })} UTC` : "—";

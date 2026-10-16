// src/components/brand.ts — XRPLHub's ratings look: deep navy and white with ONE accent (gold), drawn on top of the
// site's existing background image (which is never changed here). Our own palette; nothing borrowed from any
// credit bureau. Server- and client-safe.
import type React from "react";

export const B = {
  navy: "#0b1d3f",
  navyDeep: "rgba(7,18,40,.92)",
  navyCard: "rgba(11,29,63,.86)",
  navyLine: "rgba(255,255,255,.12)",
  white: "#ffffff",
  ink: "#e9eef8", // body text on navy
  muted: "rgba(233,238,248,.66)",
  faint: "rgba(233,238,248,.42)",
  accent: "#d4a72c", // the one accent: gold
  accentInk: "#0b1d3f", // text on accent
  accentSoft: "rgba(212,167,44,.14)",
  serif: "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif",
  sans: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
};

export const S: Record<string, React.CSSProperties> = {
  card: { background: B.navyCard, border: `1px solid ${B.navyLine}`, borderRadius: 14, padding: 18, color: B.ink, backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)" },
  btnPrimary: { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "11px 16px", borderRadius: 10, background: B.accent, color: B.accentInk, fontWeight: 800, fontSize: 14, border: "none", cursor: "pointer", textDecoration: "none", fontFamily: B.sans, minHeight: 44 },
  btnSecondary: { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "11px 16px", borderRadius: 10, background: "transparent", color: B.white, fontWeight: 700, fontSize: 14, border: `1px solid ${B.white}`, cursor: "pointer", textDecoration: "none", fontFamily: B.sans, minHeight: 44 },
  eyebrow: { fontSize: 11, fontWeight: 800, letterSpacing: ".14em", textTransform: "uppercase", color: B.accent, fontFamily: B.sans },
  h2: { fontFamily: B.serif, fontSize: "clamp(22px,4.6vw,30px)", fontWeight: 700, color: B.white, margin: "0 0 6px", lineHeight: 1.2 },
  input: { width: "100%", minWidth: 0, padding: "12px 13px", borderRadius: 10, border: `1px solid ${B.navyLine}`, background: "rgba(255,255,255,.96)", color: "#0b1d3f", fontSize: 16, fontFamily: B.sans },
  small: { fontSize: 12, color: B.faint, lineHeight: 1.5 },
};

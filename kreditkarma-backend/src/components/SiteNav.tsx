"use client";
import type React from "react";
// src/components/SiteNav.tsx — the site navigation: Wallet check, Yield ratings, Lending tracker, Pro, API, Grants.
// Navy bar, white type, gold for the current page. Collapses to a menu button under 760px.
import { useState } from "react";
import { B } from "@/components/brand";

export const NAV = [
  { id: "check", label: "Wallet check", href: "/#check" },
  { id: "yield", label: "Yield ratings", href: "/yield" },
  { id: "lending", label: "Lending tracker", href: "/lending" },
  { id: "pro", label: "Pro", href: "/pro" },
  { id: "api", label: "API", href: "/developers" },
  { id: "grants", label: "Grants", href: "/grants" },
] as const;

export default function SiteNav({ active, right }: { active?: (typeof NAV)[number]["id"]; right?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const link = (n: (typeof NAV)[number], block = false) => (
    <a key={n.id} href={n.href} onClick={() => setOpen(false)} aria-current={active === n.id ? "page" : undefined}
      style={{ color: active === n.id ? B.accent : B.white, textDecoration: "none", fontWeight: 700, fontSize: 14, padding: block ? "12px 4px" : "8px 10px", display: block ? "block" : "inline-block", borderBottom: block ? `1px solid ${B.navyLine}` : undefined, whiteSpace: "nowrap" }}>
      {n.label}
    </a>
  );
  return (
    <header style={{ position: "sticky", top: 0, zIndex: 50, background: "rgba(7,18,40,.94)", borderBottom: `1px solid ${B.navyLine}`, backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)", fontFamily: B.sans }}>
      <style>{`.sn-desk{display:flex}.sn-mob{display:none}@media(max-width:760px){.sn-desk{display:none}.sn-mob{display:inline-flex}}`}</style>
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "0 16px", minHeight: 60, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <a href="/" style={{ display: "flex", alignItems: "center", gap: 9, textDecoration: "none" }} aria-label="XRPLHub home">
          <span aria-hidden="true" style={{ width: 30, height: 30, borderRadius: 7, background: B.white, color: B.navy, display: "inline-flex", alignItems: "center", justifyContent: "center", fontFamily: B.serif, fontWeight: 800, fontSize: 17 }}>X</span>
          <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.05 }}>
            <span style={{ color: B.white, fontFamily: B.serif, fontWeight: 700, fontSize: 19 }}>XRPLHub</span>
            <span style={{ color: B.accent, fontSize: 9.5, fontWeight: 800, letterSpacing: ".16em", textTransform: "uppercase" }}>Ratings</span>
          </span>
        </a>
        <nav className="sn-desk" aria-label="Main" style={{ alignItems: "center", gap: 2 }}>{NAV.map((n) => link(n))}{right}</nav>
        <button className="sn-mob" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Menu"
          style={{ alignItems: "center", justifyContent: "center", width: 44, height: 44, borderRadius: 10, background: "transparent", border: `1px solid ${B.navyLine}`, color: B.white, fontSize: 20, cursor: "pointer" }}>
          {open ? "✕" : "☰"}
        </button>
      </div>
      {open && <nav aria-label="Main" style={{ padding: "0 16px 10px", background: "rgba(7,18,40,.98)" }}>{NAV.map((n) => link(n, true))}{right}</nav>}
    </header>
  );
}

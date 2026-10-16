import type React from "react";
// src/app/developers/page.tsx — the API page: grade APIs ($0.02 per call over x402), the free JSON, and Pro.
import type { Metadata } from "next";
import SiteNav from "@/components/SiteNav";
import { B, S } from "@/components/brand";

export const metadata: Metadata = {
  title: "XRPLHub API: Risk Grades for XRP Yield and XRPL Lending, Wallet Scores | XRPLHub",
  description: "Pay-per-call risk grades ($0.02 over x402, no account), free Yield Desk JSON, an MCP server for AI agents, and the XRPLScore wallet score API.",
  alternates: { canonical: "https://www.xrplhub.io/developers" },
};

const code: React.CSSProperties = { display: "block", background: "rgba(255,255,255,.95)", color: "#0b1d3f", padding: "10px 12px", borderRadius: 8, fontSize: 12.5, overflowX: "auto", whiteSpace: "pre", margin: "8px 0 0" };

export default function DevelopersPage() {
  const rows: { name: string; price: string; what: string; how: string; href: string }[] = [
    { name: "Yield grade", price: "$0.02 per call", what: "A–F risk grade, rate, size, lockup, custody and source for one way to earn on XRP or RLUSD.", how: "GET https://uxus.finance/api/yield/grade?id=doppler-xrp-vault-xrpl", href: "https://www.xrplhub.io/api/yield/options" },
    { name: "Lending grade", price: "$0.02 per call", what: "A–F risk grade for an XRPL lending vault or loan broker (live once XRPL lending is enabled).", how: "GET https://uxus.finance/api/lending/grade?id=<64-hex id>", href: "/lending/method" },
    { name: "Yield Desk data", price: "Free", what: "Every option with its grade, as JSON. Same data as the pages.", how: "GET https://www.xrplhub.io/api/yield/options", href: "/yield" },
    { name: "Wallet score (XRPLScore)", price: "See pricing", what: "A 300–850 wallet score from public XRP Ledger history.", how: "GET https://www.xrplhub.io/api/score/<r-address>", href: "/pricing" },
  ];
  return (
    <div style={{ minHeight: "100vh", fontFamily: B.sans, color: B.ink }}>
      <SiteNav active="api" />
      <main style={{ maxWidth: 860, margin: "0 auto", padding: "22px 16px 60px" }}>
        <div style={S.eyebrow}>API</div>
        <h1 style={{ fontFamily: B.serif, fontSize: "clamp(28px,6vw,40px)", color: B.white, margin: "6px 0 8px" }}>Ratings you can call</h1>
        <p style={{ margin: "0 0 18px", lineHeight: 1.55 }}>
          Paid calls use x402: your client or AI agent gets a 402 with the price, pays $0.02 in USDC on Base from its own wallet, and
          retries. No account, no key. An unknown id is answered with 404 before payment, so you&apos;re never charged for nothing.
          With an <a href="/pro" style={{ color: B.accent }}>XRPLHub Pro</a> key, send <code>Authorization: Bearer uxus_…</code> instead (20,000 calls a month).
        </p>
        {rows.map((r) => (
          <section key={r.name} style={{ ...S.card, marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <strong style={{ color: B.white, fontSize: 17 }}>{r.name}</strong>
              <span style={{ color: B.accent, fontWeight: 800 }}>{r.price}</span>
            </div>
            <p style={{ margin: "6px 0 0" }}>{r.what} <a href={r.href} style={{ color: B.accent }}>More</a></p>
            <code style={code}>{r.how}</code>
          </section>
        ))}
        <section style={S.card}>
          <strong style={{ color: B.white, fontSize: 17 }}>MCP server for AI agents</strong>
          <p style={{ margin: "6px 0 0" }}>Tools <code>yield_grade</code> and <code>lending_grade</code> (paid) plus free wallet tools, over Streamable HTTP.</p>
          <code style={code}>https://uxus.finance/api/mcp</code>
        </section>
        <p style={{ ...S.small, marginTop: 14 }}>Risk grades and wallet scores are general information from public data, not advice, not credit ratings and not consumer reports.</p>
      </main>
    </div>
  );
}

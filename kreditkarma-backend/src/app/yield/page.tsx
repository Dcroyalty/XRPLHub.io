// src/app/yield/page.tsx — the XRP Yield Desk: every way to earn on XRP or RLUSD we can verify from public data,
// each with an A–F risk grade. Data: src/lib/yieldDesk.ts (refreshed hourly). Mobile-first: one column of cards.
import type { Metadata } from "next";
import { prisma } from "@/lib/xrplscore-db";
import { listYield, lastRefresh, YIELD_CONSENT } from "@/lib/yieldDesk";
import { L, C, fmtTime } from "../lending/ui";
import { Disclaimer, YieldNav, OptionCard } from "./parts";
import VisitBeacon from "./VisitBeacon";
import YieldSignupForm from "./YieldSignupForm";

export const revalidate = 600;

export const metadata: Metadata = {
  title: "XRP Yield Desk: Every Way to Earn on XRP and RLUSD, Risk-Graded A–F | XRPLHub",
  description:
    "Live rates, size, lockups and who holds the keys for every verifiable way to earn yield on XRP and RLUSD — XRPL AMM pools, Doppler vaults, Flare FXRP, exchange earn — each with a published A–F risk grade.",
  alternates: { canonical: "https://www.xrplhub.io/yield" },
};

type Props = { searchParams: Promise<{ asset?: string }> };

export default async function YieldPage({ searchParams }: Props) {
  const { asset: raw } = await searchParams;
  const asset = raw === "RLUSD" ? "RLUSD" : raw === "XRP" ? "XRP" : undefined;
  const [rows, refreshed] = await Promise.all([listYield(prisma, asset), lastRefresh(prisma)]);
  const tab = (label: string, value?: string) => {
    const active = (value ?? undefined) === asset;
    return (
      <a href={value ? `/yield?asset=${value}` : "/yield"} style={{ padding: "7px 14px", borderRadius: 999, fontSize: 14, fontWeight: 700, textDecoration: "none", border: `1px solid ${active ? C.accent : C.border}`, background: active ? C.accent : "transparent", color: active ? "#0b1d3f" : C.fg }}>
        {label}
      </a>
    );
  };
  return (
    <div style={L.shell}>
      <div style={L.page}>
        <YieldNav />
        <VisitBeacon path="/yield" />
        <h1 style={L.h1}>XRP Yield Desk</h1>
        <p style={L.sub}>
          Every way to earn on XRP or RLUSD that we can check from public data, with the rate, the size, how you get your money
          out, who holds the keys — and an A–F risk grade from our <a href="/yield/method" style={L.link}>published method</a>.
        </p>
        <Disclaimer />

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "4px 0 14px" }}>
          {tab("All")}
          {tab("XRP", "XRP")}
          {tab("RLUSD", "RLUSD")}
          <a href="/yield/best-xrp-yield" style={{ ...L.link, alignSelf: "center", marginLeft: "auto", fontSize: 14 }}>Best ways to earn on XRP →</a>
        </div>

        {rows.length === 0 ? (
          <div style={L.card}><p style={{ margin: 0 }}>The first data refresh hasn&apos;t finished yet. Check back in an hour.</p></div>
        ) : (
          rows.map(({ o }) => <OptionCard key={o.slug} o={o} />)
        )}
        <p style={{ ...L.small, margin: "4px 0 18px" }}>
          {rows.length} options · sorted by risk grade, then rate · data refreshed {refreshed ? fmtTime(refreshed.toISOString()) : "—"}.
          Each source is read on its own; a card shows when its numbers were read. Rates change and are not promises.
        </p>

        <div style={L.card}>
          <p style={L.h2}>Get an email when a grade changes</p>
          <p style={{ margin: "0 0 10px", fontSize: 14, color: C.muted }}>Free. One email per change, nothing else.</p>
          <YieldSignupForm consent={YIELD_CONSENT} />
        </div>

        <div style={L.card}>
          <p style={L.h2}>What&apos;s included, and what isn&apos;t</p>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14 }}>
            <li style={{ margin: "5px 0" }}><strong>XRP Ledger AMM pools</strong> (XRP paired with RLUSD or USDC): fee income counted from the pool&apos;s own trades.</li>
            <li style={{ margin: "5px 0" }}><strong>Doppler Finance</strong> vaults: balances and the rate actually paid, from Doppler&apos;s public API.</li>
            <li style={{ margin: "5px 0" }}><strong>Flare FXRP products</strong> (Firelight stXRP, Kinetic, SparkDEX, Spectra and others): read from the stXRP contract and DefiLlama.</li>
            <li style={{ margin: "5px 0" }}><strong>RLUSD and XRP on other chains</strong> with at least $250K in them, from DefiLlama.</li>
            <li style={{ margin: "5px 0" }}><strong>Exchange earn programs</strong> that publish their rate without a login (Binance Simple Earn, OKX Savings).</li>
            <li style={{ margin: "5px 0" }}><strong>XRPL lending vaults</strong> (XLS-66) appear here once lending is switched on — <a href="/lending" style={L.link}>track it</a>.</li>
          </ul>
          <p style={{ ...L.small, marginTop: 10 }}>Products that don&apos;t publish numbers we can check are left out rather than guessed. Links go to each product&apos;s own site, with no referral codes.</p>
        </div>

        <div style={L.card}>
          <p style={L.h2}>For developers and funds</p>
          <p style={{ margin: 0, fontSize: 14 }}>
            Every grade with its full breakdown is available as an API (<code>yield_grade</code>, $0.02 a call over x402, also an MCP tool) at{" "}
            <a href="https://uxus.finance/pricing" style={L.link}>uxus.finance</a>. <strong>XRPLHub Pro</strong> ($49/month) adds webhook alerts for yield and lending grade changes and 20,000 grade calls a month.
          </p>
        </div>
      </div>
    </div>
  );
}

// src/app/yield/best-xrp-yield/page.tsx — "Best ways to earn yield on XRP". Written from the live Yield Desk data,
// so it never goes stale: "best" here means best risk grade for each kind of option, not a recommendation.
import type { Metadata } from "next";
import { prisma } from "@/lib/xrplscore-db";
import { listYield, lastRefresh, type StoredYield } from "@/lib/yieldDesk";
import { L, C, fmtTime } from "../../lending/ui";
import VisitBeacon from "../VisitBeacon";
import { Disclaimer, YieldNav, OptionCard, pct } from "../parts";

export const revalidate = 600;

export const metadata: Metadata = {
  title: "Best Ways to Earn Yield on XRP (Live Rates, Risk-Graded) | XRPLHub",
  description:
    "Where you can earn on XRP today — XRPL AMM pools, Doppler, Firelight stXRP on Flare, exchange earn — with live rates and an A–F risk grade for each. Updated hourly. General information, not advice.",
  alternates: { canonical: "https://www.xrplhub.io/yield/best-xrp-yield" },
};

const FAQ: [string, string][] = [
  ["Can you stake XRP?", "Not on the XRP Ledger itself: it has no staking, and validators are not paid. Every XRP yield comes from somewhere else — trading fees in an AMM pool, lending, trading strategies run by a company, or DeFi on another chain after converting XRP to a token like FXRP."],
  ["Where does XRP yield come from?", "From people paying to use your XRP: traders paying fees to an AMM pool, borrowers paying interest, or a company running trading strategies with it. If you can't tell where the yield comes from, that is a risk in itself."],
  ["Why is a higher rate graded lower?", "Higher rates usually pay for extra risk: a company holding your keys, a bridge, a new contract, reward tokens that can stop, or price swings in a two-token pool. The grade counts those risks; it does not judge whether the rate is worth it for you."],
  ["Is my XRP safe in an AMM pool?", "The pool is part of the XRP Ledger and your share stays in your own wallet, so there is no company or bridge to fail. The main risk is price: if XRP's price moves a lot against the other token, you can end up with less than if you had just held."],
  ["Do you get paid by any of these?", "No. We take no money from the products we grade and no commission on deposits. Links have no referral codes."],
];

function pick(rows: StoredYield[], filter: (o: StoredYield) => boolean, n = 3) {
  return rows.filter(filter).slice(0, n);
}

export default async function BestXrpYieldPage() {
  const [all, refreshed] = await Promise.all([listYield(prisma, "XRP"), lastRefresh(prisma)]);
  const rows = all.map((r) => r.o).filter((o) => o.rate != null && o.rate > 0);
  const sections: { title: string; body: string; items: StoredYield[] }[] = [
    { title: "Best risk grades overall", body: "The options with the fewest visible risks, whatever the rate.", items: pick(rows, () => true) },
    { title: "Keep your own keys", body: "No company holds your XRP: either a native XRP Ledger feature, or a smart contract you control from your own wallet.", items: pick(rows, (o) => o.custody === "self" || o.custody === "contract") },
    { title: "Higher rates (3% a year or more)", body: "What the higher numbers cost in risk — read the grade breakdown before anything else.", items: pick(rows, (o) => (o.rate ?? 0) >= 0.03) },
    { title: "On the XRP Ledger itself", body: "No bridge, no other chain.", items: pick(rows, (o) => o.chain === "XRP Ledger") },
    { title: "On an exchange", body: "The simplest to use; the exchange holds your coins.", items: pick(rows, (o) => o.custody === "exchange") },
  ];
  const top = rows[0];
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQ.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })),
  };
  return (
    <div style={L.shell}>
      <div style={L.page}>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
        <YieldNav back={{ href: "/yield", label: "Yield Desk" }} />
        <VisitBeacon path="/yield/best-xrp-yield" />
        <h1 style={L.h1}>Best ways to earn yield on XRP</h1>
        <p style={L.sub}>
          {rows.length} ways to earn on XRP that we can check from public data right now
          {top ? <>, from {pct(Math.min(...rows.map((o) => o.rate!)))} to {pct(Math.max(...rows.map((o) => o.rate!)))} a year</> : null}. Grouped by what
          matters most to you, each with its risk grade. Updated {refreshed ? fmtTime(refreshed.toISOString()) : "hourly"}.
        </p>
        <Disclaimer />

        {sections.map((s) => (
          <section key={s.title} style={{ marginBottom: 18 }}>
            <h2 style={{ ...L.h2, margin: "18px 0 4px" }}>{s.title}</h2>
            <p style={{ ...L.small, fontSize: 13, margin: "0 0 10px" }}>{s.body}</p>
            {s.items.length ? s.items.map((o) => <OptionCard key={o.slug} o={o} />) : <p style={{ fontSize: 14, color: C.muted }}>Nothing in this group right now.</p>}
          </section>
        ))}

        <p style={{ fontSize: 14 }}><a href="/yield?asset=XRP" style={L.link}>See every XRP option →</a> · <a href="/yield?asset=RLUSD" style={L.link}>RLUSD options →</a> · <a href="/yield/method" style={L.link}>How we grade →</a></p>

        <div style={L.card}>
          <h2 style={L.h2}>Questions</h2>
          {FAQ.map(([q, a]) => (
            <div key={q} style={{ margin: "10px 0" }}>
              <h3 style={{ fontSize: 15, margin: "0 0 3px" }}>{q}</h3>
              <p style={{ margin: 0, fontSize: 14 }}>{a}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// app/pricing/page.tsx
// Renders straight from lib/plans.ts, so the numbers advertised here and the
// numbers guard.ts enforces can never drift. Mobile-first stacked cards.
//
// Styling is intentionally plain — swap the classNames for your own design
// tokens. The structure and the data wiring are what matter.

import { PLAN_ORDER, PLANS } from "@/lib/plans";
import PlanCta from "./PlanCta";
import FreeKeyModal from "./FreeKeyModal";
import SiteNav from "@/components/SiteNav";
import { B } from "@/components/brand";

export const metadata = {
  title: "XRPLScore — Pricing",
  description: "Wallet risk scoring for the XRP Ledger. Priced per plan, paid in XRP or RLUSD.",
};

export default function PricingPage() {
  return (
    <div style={styles.shell}>
    <SiteNav active="api" />
    <main style={styles.page}>

      <header style={styles.header}>
        <h1 style={styles.h1}>XRPLScore API</h1>
        <p style={styles.sub}>
          A 300–850 risk score for any XRPL wallet, from 8 signals — the same
          number the public site shows. One API call. Pay in XRP or RLUSD —
          connect Xaman and sign, no address typing.
        </p>
      </header>

      <section style={styles.grid}>
        {PLAN_ORDER.map((id) => {
          const p = PLANS[id];
          const isPaid = p.priceRlusd > 0;
          return (
            <article key={id} style={styles.card}>
              <h2 style={styles.planName}>{p.name}</h2>
              <div style={styles.price}>
                {isPaid ? (
                  <>
                    <span style={styles.amount}>{p.priceRlusd.toLocaleString()}</span>
                    <span style={styles.unit}> RLUSD / mo</span>
                  </>
                ) : (
                  <span style={styles.amount}>Free</span>
                )}
              </div>
              <p style={styles.blurb}>{p.blurb}</p>
              <ul style={styles.features}>
                {p.features.map((f) => (
                  <li key={f} style={styles.feature}>
                    {f}
                  </li>
                ))}
              </ul>
              {isPaid ? (
                <PlanCta planId={id} planName={p.name} />
              ) : (
                <FreeKeyModal />
              )}
            </article>
          );
        })}
      </section>

      <section style={styles.usage}>
        <h2 style={styles.usageH}>Using your key</h2>
        <p style={styles.usageP}>
          Checkout gives you a key once (starts <code>xrs_live_</code>). Store it —
          it can’t be shown again. Then:
        </p>
        <pre style={styles.code}>{`curl -H "authorization: Bearer xrs_live_..." \\
  "https://www.xrplhub.io/api/v1/score?wallet=rXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"`}</pre>
        <p style={styles.usageP}>
          Full schema and the pay-per-call (x402) endpoints for autonomous agents
          are in the <a href="/openapi.json" style={styles.inlineLink}>OpenAPI spec</a> and
          the <a href="/.well-known/x402" style={styles.inlineLink}>x402 discovery document</a>.
        </p>
      </section>

      <p style={styles.foot}>
        Every plan returns the same score the public site returns. No drift, ever.
      </p>
    </main>
    </div>
  );
}

// The site's one look (navy and white, one gold accent, over the site background): tokens from
// src/components/brand.ts, shared with every other page.
const card: React.CSSProperties = { border: `1px solid ${B.navyLine}`, borderRadius: 14, padding: 20, background: B.navyCard, color: B.ink };
const styles: Record<string, React.CSSProperties> = {
  shell: { color: B.ink, minHeight: "100vh" },
  page: { maxWidth: 960, margin: "0 auto", padding: "22px 16px 48px", fontFamily: B.sans },
  usage: { ...card, marginTop: 28 },
  usageH: { fontSize: 20, fontWeight: 700, margin: "0 0 8px", color: B.white },
  usageP: { color: B.ink, fontSize: 14, lineHeight: 1.6, margin: "8px 0" },
  code: { background: "rgba(255,255,255,.95)", color: B.navy, padding: 14, borderRadius: 10, fontSize: 12.5, overflowX: "auto", lineHeight: 1.6 },
  inlineLink: { color: B.accent, fontWeight: 600 },
  header: { marginBottom: 24 },
  h1: { fontSize: "clamp(30px,7vw,44px)", margin: 0, color: B.white },
  sub: { fontSize: 16, color: B.ink, maxWidth: 560, margin: "10px 0 0", lineHeight: 1.55 },
  grid: { display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,260px),1fr))" },
  card,
  planName: { fontSize: 20, margin: 0, color: B.white },
  price: { margin: "10px 0" },
  amount: { fontSize: 30, fontWeight: 800, color: B.accent },
  unit: { fontSize: 15, color: B.muted },
  blurb: { color: B.ink, margin: "0 0 14px" },
  features: { listStyle: "none", padding: 0, margin: "0 0 18px" },
  feature: { padding: "6px 0", borderTop: `1px solid ${B.navyLine}`, fontSize: 14 },
  foot: { color: B.muted, marginTop: 24, fontSize: 14 },
};

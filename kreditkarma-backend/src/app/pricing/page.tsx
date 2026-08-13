// app/pricing/page.tsx
// Renders straight from lib/plans.ts, so the numbers advertised here and the
// numbers guard.ts enforces can never drift. Mobile-first stacked cards.
//
// Styling is intentionally plain — swap the classNames for your own design
// tokens. The structure and the data wiring are what matter.

import Link from "next/link";
import { PLAN_ORDER, PLANS } from "@/lib/plans";

export const metadata = {
  title: "XRPLScore — Pricing",
  description: "Wallet risk scoring for the XRP Ledger. Priced per plan, paid in RLUSD.",
};

export default function PricingPage() {
  return (
    <main style={styles.page}>
      <header style={styles.header}>
        <h1 style={styles.h1}>XRPLScore</h1>
        <p style={styles.sub}>
          A 300–850 risk score for any XRPL wallet, from 9 signals. One API
          call. Paid in RLUSD.
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
                <Link href={`/checkout?plan=${id}`} style={styles.cta}>
                  Get {p.name}
                </Link>
              ) : (
                <Link href="/checkout?plan=free" style={styles.ctaGhost}>
                  Start free
                </Link>
              )}
            </article>
          );
        })}
      </section>

      <p style={styles.foot}>
        Every plan returns the same score the API returns. No drift, ever.
      </p>
    </main>
  );
}

// Inline styles keep this file drop-in with zero CSS setup. Replace freely.
const styles: Record<string, React.CSSProperties> = {
  page: { maxWidth: 960, margin: "0 auto", padding: "48px 20px", fontFamily: "system-ui, sans-serif" },
  header: { textAlign: "center", marginBottom: 40 },
  h1: { fontSize: 40, fontWeight: 800, margin: 0 },
  sub: { fontSize: 17, color: "#555", maxWidth: 520, margin: "12px auto 0" },
  grid: { display: "grid", gap: 20, gridTemplateColumns: "1fr" },
  card: { border: "1px solid #e6e6e6", borderRadius: 16, padding: 24, background: "#fff" },
  planName: { fontSize: 20, fontWeight: 700, margin: 0 },
  price: { margin: "12px 0" },
  amount: { fontSize: 32, fontWeight: 800 },
  unit: { fontSize: 15, color: "#777" },
  blurb: { color: "#555", margin: "0 0 16px" },
  features: { listStyle: "none", padding: 0, margin: "0 0 20px" },
  feature: { padding: "6px 0", borderTop: "1px solid #f0f0f0", fontSize: 15 },
  cta: { display: "block", textAlign: "center", padding: "12px 16px", borderRadius: 10, background: "#111", color: "#fff", textDecoration: "none", fontWeight: 600 },
  ctaGhost: { display: "block", textAlign: "center", padding: "12px 16px", borderRadius: 10, border: "1px solid #111", color: "#111", textDecoration: "none", fontWeight: 600 },
  foot: { textAlign: "center", color: "#888", marginTop: 32, fontSize: 14 },
};

// src/app/services/page.tsx — server-rendered hub linking every per-service page (src/app/services/[id]/page.tsx),
// grouped by category. Gives search engines a real internal-linking path to all 34 pages instead of relying on the
// sitemap alone, and is itself a crawlable page for broad "XRPL services" / "XRPL transaction builder" searches.
import type { Metadata } from "next";
import Link from "next/link";
import { RAW_PRODUCTS } from "@/lib/serviceContent";
import { priceInfo } from "@/lib/txPurchase";

export const dynamic = "force-static";

const ORIGIN = "https://www.xrplhub.io";
const TITLE = "34 done-for-you XRPL transaction services | XRPLHub";
const DESCRIPTION =
  "Escrows, checks, trust lines, multi-sig, AMM pools, NFTs, credentials and more — XRPLHub builds the exact unsigned XRPL transaction for 34 services. You review it and sign with your own wallet; XRPLHub never holds your keys.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: `${ORIGIN}/services` },
  openGraph: { title: TITLE, description: DESCRIPTION, url: `${ORIGIN}/services`, siteName: "XRPLHub", type: "website" },
};

function groupByCategory() {
  const groups = new Map<string, typeof RAW_PRODUCTS[number][]>();
  for (const p of RAW_PRODUCTS) {
    const arr = groups.get(p.cat) ?? [];
    arr.push(p);
    groups.set(p.cat, arr);
  }
  return groups;
}

export default function ServicesIndex() {
  const groups = groupByCategory();
  const itemListLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: RAW_PRODUCTS.map((p, i) => ({ "@type": "ListItem", position: i + 1, url: `${ORIGIN}/services/${p.id}`, name: p.name })),
  };

  return (
    <div style={{ minHeight: "100vh", background: "#030310", color: "#eeeef5", fontFamily: "'Syne',sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800;900&display=swap');*{box-sizing:border-box}`}</style>
      {/* eslint-disable-next-line react/no-danger */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(itemListLd) }} />

      <nav style={{ background: "rgba(3,4,14,.9)", borderBottom: "1px solid rgba(16,185,129,.18)", padding: "0 24px", height: 64, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Link href="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none", color: "#fff" }}>
          <div style={{ width: 32, height: 32, background: "linear-gradient(135deg,#10b981,#059669)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 900, fontSize: 15, color: "#000" }}>X</div>
          <span style={{ fontWeight: 900, fontSize: 17, letterSpacing: "-.5px" }}>XRPLHub</span>
        </Link>
        <Link href="/" style={{ fontSize: 13, color: "#10b981", textDecoration: "none", fontWeight: 600 }}>← Home</Link>
      </nav>

      <div style={{ maxWidth: 980, margin: "0 auto", padding: "48px 24px 90px" }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#10b981", letterSpacing: ".14em", textTransform: "uppercase", marginBottom: 10 }}>XRPLHub</div>
        <h1 style={{ fontSize: "clamp(28px,5vw,42px)", fontWeight: 900, letterSpacing: "-1.5px", marginBottom: 12 }}>{RAW_PRODUCTS.length} XRPL transaction services</h1>
        <p style={{ fontSize: 16, color: "rgba(255,255,255,.65)", marginBottom: 40, lineHeight: 1.7, maxWidth: 680 }}>{DESCRIPTION}</p>

        {[...groups.entries()].map(([cat, items]) => (
          <div key={cat} style={{ marginBottom: 36 }}>
            <h2 style={{ fontSize: 14, fontWeight: 800, color: "rgba(255,255,255,.4)", textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 14, borderBottom: "1px solid rgba(255,255,255,.08)", paddingBottom: 8 }}>{cat}</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(260px,1fr))", gap: 12 }}>
              {items.map((p) => {
                const price = priceInfo(p.id);
                return (
                  <Link
                    key={p.id}
                    href={`/services/${p.id}`}
                    style={{ display: "block", background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 12, padding: "16px 18px", textDecoration: "none", color: "inherit" }}
                  >
                    <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
                      <span aria-hidden="true">{p.emoji} </span>{p.name}
                    </div>
                    <div style={{ fontSize: 12.5, color: "rgba(255,255,255,.5)", marginBottom: 8, lineHeight: 1.5 }}>{p.tagline}</div>
                    {price && <div style={{ fontSize: 12, fontWeight: 700, color: p.color }}>${price.usd}</div>}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

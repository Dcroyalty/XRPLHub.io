// src/app/services/[id]/page.tsx
// One server-rendered, statically-generated page per storefront service. This is the crawlable counterpart to the
// client-rendered homepage catalog (src/lib/serviceContent.ts is the single content source for both) — real HTML in
// the initial response, a unique <title>/description per service, and Product/Offer + FAQPage JSON-LD, so a search
// engine has something to index besides one page that answers for all 34 services at once.
//
// The interactive buy flow (wallet connect, payment, signing) still lives entirely on the homepage — this page's CTA
// deep-links to /?product=<id>, which opens that exact product's modal (see the effect in page.tsx). Nothing here
// signs, builds, or prices anything itself; it reads the same static data the homepage reads.

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RAW_PRODUCTS } from "@/lib/serviceContent";
import { SERVICE_CATALOG, BUILDABLE_SERVICE_IDS } from "@/app/api/execute/serviceCatalog";
import { priceInfo } from "@/lib/txPurchase";

export const dynamic = "force-static";
export const dynamicParams = false;

const ORIGIN = "https://www.xrplhub.io";

function find(id: string) {
  const product = RAW_PRODUCTS.find((p) => p.id === id);
  const def = SERVICE_CATALOG.find((s) => s.id === id);
  return product && def ? { product, def } : null;
}

export function generateStaticParams() {
  return BUILDABLE_SERVICE_IDS.map((id) => ({ id }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const hit = find(id);
  if (!hit) return { title: "Service not found | XRPLHub" };
  const { product, def } = hit;
  const price = priceInfo(def.id);
  const title = `${product.name} — ${product.tagline} | XRPLHub`;
  const description = `${product.desc} ${price ? `$${price.usd} USD, paid in RLUSD, USDC or XRP.` : ""} Unsigned only — XRPLHub builds it, you sign with your own wallet.`.trim();
  const url = `${ORIGIN}/services/${def.id}`;
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url, siteName: "XRPLHub", type: "website" },
    twitter: { card: "summary", title, description },
  };
}

const TIER_COPY: Record<string, { label: string; note: string }> = {
  safe: { label: "Safe", note: "Additive or reversible. XRPLHub builds it and delivers the unsigned transaction with no extra confirmation step." },
  caution: {
    label: "Caution — read before you sign",
    note: "This can change how your account is controlled or what it permits, and may be difficult or impossible to reverse. Before you can sign, XRPLHub shows the exact, specific consequences for your inputs and asks you to confirm you understand them.",
  },
  blocked: {
    label: "Not auto-built",
    note: "This can permanently lock an account. XRPLHub will not build it automatically — contact support@xrplhub.io for a guided, manual process.",
  },
};

export default async function ServicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const hit = find(id);
  if (!hit) notFound();
  const { product, def } = hit;
  const price = priceInfo(def.id);
  const tier = TIER_COPY[def.tier];
  const required = def.params.filter((p) => p.required);
  const optional = def.params.filter((p) => !p.required);

  const url = `${ORIGIN}/services/${def.id}`;
  const productLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.name,
    description: product.desc,
    category: product.cat,
    brand: { "@type": "Brand", name: "XRPLHub" },
    url,
    ...(price
      ? { offers: { "@type": "Offer", price: String(price.usd), priceCurrency: "USD", availability: "https://schema.org/InStock", url } }
      : {}),
  };
  const faqEntries = [
    {
      q: "Does XRPLHub sign this transaction for me?",
      a: "No. XRPLHub builds the exact unsigned transaction and returns it to you. You review it and sign it yourself with your own wallet (Xaman, Crossmark or GemWallet). XRPLHub never holds your keys and never submits anything on your behalf.",
    },
    {
      q: `Is ${product.name} reversible?`,
      a:
        def.tier === "safe"
          ? "Yes — this service is additive or reversible; it does not permanently remove capability from your account."
          : def.tier === "blocked"
            ? "No — this action can permanently lock account access, which is why XRPLHub does not auto-build it."
            : "It depends on your inputs — some configurations of this service are permanent. XRPLHub shows the exact, specific irreversible consequences and requires you to confirm you understand them before it will build the transaction.",
    },
    {
      q: "What does it cost and how do I pay?",
      a: price
        ? `$${price.usd} USD, priced the same on every rail: RLUSD or XRP in the storefront checkout, or RLUSD on the XRP Ledger / USDC on Base via x402. The price is set by the server and verified on-ledger for every payment — it is never taken from anything the caller sends.`
        : "This service is not sold — see the note above.",
    },
    {
      q: "What XRPL transaction does this build?",
      a: `A ${product.amendment} transaction${product.aiDetail ? `. ${product.aiDetail}` : "."}`,
    },
  ];
  const faqLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqEntries.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };
  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "XRPLHub", item: ORIGIN },
      { "@type": "ListItem", position: 2, name: "Services", item: `${ORIGIN}/services` },
      { "@type": "ListItem", position: 3, name: product.name, item: url },
    ],
  };

  return (
    <div style={{ minHeight: "100vh", background: "#030310", color: "#eeeef5", fontFamily: "'Syne',sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800;900&display=swap');*{box-sizing:border-box}`}</style>
      {/* eslint-disable-next-line react/no-danger */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(productLd) }} />
      {/* eslint-disable-next-line react/no-danger */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqLd) }} />
      {/* eslint-disable-next-line react/no-danger */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbLd) }} />

      <nav style={{ background: "rgba(3,4,14,.9)", borderBottom: "1px solid rgba(16,185,129,.18)", padding: "0 24px", height: 64, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Link href="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none", color: "#fff" }}>
          <div style={{ width: 32, height: 32, background: "linear-gradient(135deg,#10b981,#059669)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 900, fontSize: 15, color: "#000" }}>X</div>
          <span style={{ fontWeight: 900, fontSize: 17, letterSpacing: "-.5px" }}>XRPLHub</span>
        </Link>
        <Link href="/services" style={{ fontSize: 13, color: "#10b981", textDecoration: "none", fontWeight: 600 }}>← All services</Link>
      </nav>

      <div style={{ maxWidth: 820, margin: "0 auto", padding: "48px 24px 90px" }}>
        <nav aria-label="Breadcrumb" style={{ fontSize: 12, color: "rgba(255,255,255,.38)", marginBottom: 18 }}>
          <Link href="/" style={{ color: "inherit", textDecoration: "none" }}>XRPLHub</Link>
          {" / "}
          <Link href="/services" style={{ color: "inherit", textDecoration: "none" }}>Services</Link>
          {" / "}
          <span style={{ color: "rgba(255,255,255,.7)" }}>{product.name}</span>
        </nav>

        <div style={{ fontSize: 11, fontWeight: 700, color: product.color, letterSpacing: ".14em", textTransform: "uppercase", marginBottom: 10 }}>
          {product.cat} · {product.amendment}
        </div>
        <h1 style={{ fontSize: "clamp(28px,5vw,42px)", fontWeight: 900, letterSpacing: "-1.5px", marginBottom: 8 }}>
          <span aria-hidden="true">{product.emoji} </span>{product.name}
        </h1>
        <p style={{ fontSize: 17, color: "rgba(255,255,255,.72)", marginBottom: 20, lineHeight: 1.5 }}>{product.tagline}</p>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 28 }}>
          {price && (
            <div style={{ background: "rgba(16,185,129,.08)", border: "1px solid rgba(16,185,129,.25)", borderRadius: 10, padding: "10px 16px" }}>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)" }}>Price</div>
              <div style={{ fontSize: 18, fontWeight: 800 }}>${price.usd} <span style={{ fontSize: 12, fontWeight: 500, color: "rgba(255,255,255,.5)" }}>RLUSD / USDC / XRP</span></div>
            </div>
          )}
          <div style={{ background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.1)", borderRadius: 10, padding: "10px 16px" }}>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)" }}>Safety tier</div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{tier.label}</div>
          </div>
        </div>

        <Link
          href={def.tier === "blocked" ? "/support" : `/?product=${def.id}`}
          style={{ display: "inline-block", background: def.tier === "blocked" ? "rgba(255,255,255,.08)" : `linear-gradient(135deg,${product.color},#059669)`, color: def.tier === "blocked" ? "#eeeef5" : "#001510", fontWeight: 800, fontSize: 15, padding: "14px 28px", borderRadius: 10, textDecoration: "none", marginBottom: 36 }}
        >
          {def.tier === "blocked" ? "Contact support →" : `Build & sign this →`}
        </Link>

        <h2 style={{ fontSize: 15, fontWeight: 800, color: "#10b981", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 10 }}>What you get</h2>
        <p style={{ fontSize: 15, color: "rgba(255,255,255,.75)", lineHeight: 1.8, marginBottom: 26 }}>{product.desc}</p>

        <h2 style={{ fontSize: 15, fontWeight: 800, color: "#10b981", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 10 }}>How it works</h2>
        <p style={{ fontSize: 15, color: "rgba(255,255,255,.75)", lineHeight: 1.8, marginBottom: 10 }}>{def.gives}</p>
        <p style={{ fontSize: 14, color: "rgba(255,255,255,.55)", lineHeight: 1.8, marginBottom: 26 }}>{product.aiDetail}</p>

        <div style={{ background: def.tier === "safe" ? "rgba(16,185,129,.06)" : "rgba(251,191,36,.08)", border: `1px solid ${def.tier === "safe" ? "rgba(16,185,129,.2)" : "rgba(251,191,36,.3)"}`, borderRadius: 12, padding: "16px 20px", marginBottom: 30 }}>
          <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 6 }}>{tier.label}</div>
          <div style={{ fontSize: 13.5, color: "rgba(255,255,255,.72)", lineHeight: 1.7 }}>{tier.note}</div>
        </div>

        {product.features.length > 0 && (
          <>
            <h2 style={{ fontSize: 15, fontWeight: 800, color: "#10b981", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 10 }}>Included</h2>
            <ul style={{ margin: "0 0 26px", padding: 0, listStyle: "none" }}>
              {product.features.map((f) => (
                <li key={f} style={{ fontSize: 14, color: "rgba(255,255,255,.7)", padding: "6px 0", borderBottom: "1px solid rgba(255,255,255,.06)" }}>✓ {f}</li>
              ))}
            </ul>
          </>
        )}

        {def.params.length > 0 && (
          <>
            <h2 style={{ fontSize: 15, fontWeight: 800, color: "#10b981", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 10 }}>What you provide</h2>
            <div style={{ marginBottom: 30 }}>
              {[...required, ...optional].map((p) => (
                <div key={p.name} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13.5, padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,.06)" }}>
                  <div>
                    <span style={{ fontFamily: "'IBM Plex Mono',monospace", color: "#eeeef5" }}>{p.name}</span>
                    {p.required ? <span style={{ color: "#f87171", marginLeft: 6, fontSize: 11 }}>required</span> : <span style={{ color: "rgba(255,255,255,.35)", marginLeft: 6, fontSize: 11 }}>optional</span>}
                    <div style={{ color: "rgba(255,255,255,.5)", marginTop: 2 }}>{p.desc}</div>
                  </div>
                  <div style={{ color: "rgba(255,255,255,.35)", fontFamily: "'IBM Plex Mono',monospace", whiteSpace: "nowrap" }}>{p.example}</div>
                </div>
              ))}
            </div>
          </>
        )}

        <h2 style={{ fontSize: 15, fontWeight: 800, color: "#10b981", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 10 }}>Frequently asked</h2>
        <div style={{ marginBottom: 30 }}>
          {faqEntries.map((f) => (
            <div key={f.q} style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 14.5, fontWeight: 700, marginBottom: 4 }}>{f.q}</div>
              <div style={{ fontSize: 14, color: "rgba(255,255,255,.62)", lineHeight: 1.7 }}>{f.a}</div>
            </div>
          ))}
        </div>

        <p style={{ fontSize: 12, color: "rgba(255,255,255,.3)", marginTop: 40 }}>
          XRPLHub builds and describes XRPL transactions only. It never signs, never submits, and never holds keys. See{" "}
          <Link href="/services" style={{ color: "#10b981" }}>every service</Link>, or check any wallet&rsquo;s <Link href="/" style={{ color: "#10b981" }}>XRPLScore</Link> first.
        </p>
      </div>
    </div>
  );
}

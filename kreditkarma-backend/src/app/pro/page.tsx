// src/app/pro/page.tsx — XRPLHub Pro: $49/month by card, or 49 RLUSD for 30 days with Xaman.
import type { Metadata } from "next";
import SiteNav from "@/components/SiteNav";
import ProBuy from "@/components/ProBuy";
import { B, S } from "@/components/brand";

export const metadata: Metadata = {
  title: "XRPLHub Pro: Risk-Grade Alerts for XRP Yield and Lending | XRPLHub",
  description: "Webhook alerts when a Yield Desk or XRPL lending risk grade changes, plus 20,000 grade API calls a month. $49/month by card, or 49 RLUSD for 30 days with Xaman.",
  alternates: { canonical: "https://www.xrplhub.io/pro" },
};

export default function ProPage() {
  return (
    <div style={{ minHeight: "100vh", fontFamily: B.sans, color: B.ink }}>
      <SiteNav active="pro" />
      <main style={{ maxWidth: 760, margin: "0 auto", padding: "22px 16px 60px" }}>
        <div style={S.eyebrow}>XRPLHub Pro</div>
        <h1 style={{ fontFamily: B.serif, fontSize: "clamp(30px,7vw,44px)", color: B.white, margin: "6px 0 8px", lineHeight: 1.1 }}>Know the moment a rating changes.</h1>
        <p style={{ fontSize: 17, margin: "0 0 18px", lineHeight: 1.55 }}>For funds, builders and anyone with money in XRP yield products or XRPL lending vaults.</p>
        <div style={S.card}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontFamily: B.serif, fontSize: 40, color: B.white, fontWeight: 700 }}>$49</span>
            <span>a month by card · or 49 RLUSD for 30 days with Xaman</span>
          </div>
          <ul style={{ margin: "12px 0 16px", paddingLeft: 18, lineHeight: 1.65 }}>
            <li>Signed webhook alerts when a <a href="/yield" style={{ color: B.accent }}>Yield Desk</a> risk grade changes</li>
            <li>The same for XRPL lending vaults and loan brokers, once lending is live on mainnet</li>
            <li>20,000 <code>yield_grade</code> and <code>lending_grade</code> API calls a month, with full grade history</li>
          </ul>
          <ProBuy />
          <p style={{ ...S.small, margin: "12px 0 0" }}>
            Card subscriptions renew monthly; cancel any time in the Stripe customer portal. Xaman payments cover 30 days and don&apos;t renew by themselves.
            Risk grades are general information from public data, not advice and not credit ratings. We are never paid by the products we grade.
          </p>
        </div>
        <p style={{ fontSize: 14, marginTop: 16 }}>Developers: see the <a href="/developers" style={{ color: B.accent }}>API page</a>. Questions: support@uxus.finance.</p>
      </main>
    </div>
  );
}

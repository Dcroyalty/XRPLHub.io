"use client";
// app/checkout/page.tsx
// Thin page wrapper: reads ?plan= and renders the shared <CheckoutFlow>.
// The flow itself (currency toggle, Xaman connect, manual fallback, polling,
// key reveal) lives in CheckoutFlow.tsx so /pricing can reuse it in a modal.

import { useEffect, useState } from "react";
import CheckoutFlow from "./CheckoutFlow";
import { getPlan } from "@/lib/plans";

export default function CheckoutPage() {
  const [plan, setPlan] = useState<string>("");

  useEffect(() => {
    setPlan(new URLSearchParams(window.location.search).get("plan") ?? "");
  }, []);

  const p = plan ? getPlan(plan) : null;
  const title =
    !plan ? "Checkout"
    : plan === "free" ? "Free plan"
    : `Get ${p?.name ?? plan} — $${p?.priceRlusd ?? ""}/mo`;

  return (
    <main style={s.page}>
      <a href="/pricing" style={s.back}>← plans</a>
      <h1 style={s.h1}>{title}</h1>
      {plan ? <CheckoutFlow plan={plan} /> : <p style={s.p}>Pick a plan on the pricing page.</p>}
    </main>
  );
}

const s: Record<string, React.CSSProperties> = {
  page: { maxWidth: 520, margin: "0 auto", padding: "32px 20px 48px", fontFamily: "system-ui, sans-serif" },
  back: { fontSize: 13, color: "#777", textDecoration: "none" },
  h1: { fontSize: 24, fontWeight: 800, margin: "12px 0 20px" },
  p: { color: "#444", lineHeight: 1.5 },
};

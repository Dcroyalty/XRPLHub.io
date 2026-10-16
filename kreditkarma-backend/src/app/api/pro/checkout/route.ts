// src/app/api/pro/checkout/route.ts — "Buy with card" for XRPLHub Pro ($49/month): GET → 303 to Stripe Checkout.
// The session is created server-to-server on uxus.finance, which sells Pro and issues the key.
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const r = await fetch("https://uxus.finance/api/billing/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: "xrplhub_pro" }), signal: AbortSignal.timeout(15_000), cache: "no-store" });
    const j = (await r.json().catch(() => ({}))) as { url?: string };
    if (r.ok && j.url && j.url.startsWith("https://checkout.stripe.com/")) return NextResponse.redirect(j.url, 303);
  } catch { /* fall through to the pricing page */ }
  return NextResponse.redirect("https://uxus.finance/pricing#xrplhub-pro", 303);
}

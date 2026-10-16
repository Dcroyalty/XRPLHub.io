// src/app/api/grants/donate-card/route.ts — "Donate by card": GET ?amount=<USD> → 303 to Stripe Checkout.
// The session is created server-to-server on uxus.finance (Morrbiz LLC's Stripe account, app/api/billing/donate).
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const amount = Number(new URL(req.url).searchParams.get("amount"));
  const back = (msg: string) => NextResponse.redirect(new URL(`/grants?card_error=${encodeURIComponent(msg)}#donate`, req.url), 303);
  if (!Number.isFinite(amount) || amount < 5 || amount > 10_000) return back("Choose an amount from $5 to $10,000.");
  try {
    const r = await fetch("https://uxus.finance/api/billing/donate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amountUsd: amount }), signal: AbortSignal.timeout(15_000), cache: "no-store" });
    const j = (await r.json().catch(() => ({}))) as { url?: string; message?: string };
    if (!r.ok || !j.url || !j.url.startsWith("https://checkout.stripe.com/")) return back(j.message ?? "Couldn't start the card payment. Try again in a minute.");
    return NextResponse.redirect(j.url, 303);
  } catch {
    return back("Couldn't start the card payment. Try again in a minute.");
  }
}

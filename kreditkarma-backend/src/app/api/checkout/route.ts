// app/api/checkout/route.ts
// POST { plan } -> creates an Invoice with a unique 32-bit destination tag
// and returns everything the payer needs. One treasury wallet, one tag per
// invoice — no wallet-per-customer, no key management.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { getPlan } from "@/lib/plans";
import { manualPayFields, TREASURY_ADDRESS } from "@/lib/rlusd";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TAG = 4_294_967_295; // 32-bit unsigned max
const INVOICE_TTL_MIN = 30;

function randomTag(): number {
  // 1..MAX_TAG (avoid 0 so "no tag" is always distinguishable)
  return 1 + Math.floor(Math.random() * (MAX_TAG - 1));
}

export async function POST(req: Request) {
  if (!TREASURY_ADDRESS) {
    return NextResponse.json(
      { error: "misconfigured", message: "TREASURY_ADDRESS is not set." },
      { status: 500 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as { plan?: string };
  const plan = getPlan(body.plan ?? "");
  if (plan.priceRlusd <= 0) {
    return NextResponse.json(
      { error: "bad_request", message: "Pick a paid plan to check out." },
      { status: 400 }
    );
  }

  // Allocate a unique destination tag (retry on the rare collision).
  let invoice = null;
  for (let attempt = 0; attempt < 5 && !invoice; attempt++) {
    const destinationTag = randomTag();
    try {
      invoice = await prisma.invoice.create({
        data: {
          plan: plan.id,
          amountRlusd: plan.priceRlusd,
          destinationTag,
          status: "pending",
          expiresAt: new Date(Date.now() + INVOICE_TTL_MIN * 60_000),
        },
      });
    } catch {
      // unique constraint on destinationTag hit — try another
    }
  }
  if (!invoice) {
    return NextResponse.json(
      { error: "retry", message: "Could not allocate an invoice tag. Try again." },
      { status: 503 }
    );
  }

  return NextResponse.json(
    {
      invoiceId: invoice.id,
      plan: plan.id,
      amountRlusd: plan.priceRlusd,
      expiresAt: invoice.expiresAt,
      // Manual-pay panel data (works for exchange withdrawals too).
      pay: manualPayFields(plan.priceRlusd, invoice.destinationTag),
      // Xaman deeplink: opens the app pre-filled. (Optional; QR also works.)
      xamanDeeplink: buildXamanDeeplink(plan.priceRlusd, invoice.destinationTag),
      statusUrl: `/api/checkout/status?id=${invoice.id}`,
    },
    { status: 201 }
  );
}

// A simple xumm:// deeplink carrying amount, issuer, currency and tag. If you
// wire the Xumm/Xaman API with server creds you can return a hosted payload +
// QR instead; this deeplink needs no credentials.
function buildXamanDeeplink(amount: number, tag: number): string {
  const params = new URLSearchParams({
    to: TREASURY_ADDRESS,
    amount: amount.toFixed(6),
    currency: "524C555344000000000000000000000000000000",
    issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
    dt: String(tag),
  });
  return `https://xumm.app/detect/request?${params.toString()}`;
}

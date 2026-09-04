// app/api/checkout/route.ts
// POST { plan, currency } -> creates an Invoice with a unique 32-bit destination
// tag and returns everything the payer needs. currency is "RLUSD" (default) or
// "XRP". For XRP the amount is the plan's USD price converted at a live rate,
// locked into the invoice with a small buffer for rate movement over the TTL.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { getPlan } from "@/lib/plans";
import {
  manualPayFields,
  manualPayFieldsXrp,
  xamanDeeplink,
  TREASURY_ADDRESS,
} from "@/lib/rlusd";
import { xrpUsd } from "@/lib/xrpPrice";
import { xummConfigured } from "@/lib/xumm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TAG = 2_147_483_647; // Invoice.destinationTag is a signed INT4
const INVOICE_TTL_MIN = 30;
const XRP_RATE_BUFFER = 1.02; // +2% headroom for XRP/USD drift over the 30-min TTL

function randomTag(): number {
  return 1 + Math.floor(Math.random() * (MAX_TAG - 1));
}

export async function POST(req: Request) {
  if (!TREASURY_ADDRESS) {
    return NextResponse.json(
      { error: "misconfigured", message: "TREASURY_ADDRESS is not set." },
      { status: 500 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as { plan?: string; currency?: string };
  const plan = getPlan(body.plan ?? "");
  if (plan.priceRlusd <= 0) {
    return NextResponse.json(
      { error: "bad_request", message: "Pick a paid plan to check out." },
      { status: 400 }
    );
  }
  const currency: "RLUSD" | "XRP" = body.currency === "XRP" ? "XRP" : "RLUSD";

  // For XRP, lock the amount from a live rate now.
  let amountXrp: number | null = null;
  let xrpRate: number | null = null;
  if (currency === "XRP") {
    try {
      xrpRate = await xrpUsd();
      amountXrp = Math.ceil((plan.priceRlusd / xrpRate) * XRP_RATE_BUFFER * 1e6) / 1e6;
    } catch {
      return NextResponse.json(
        { error: "xrp_price_unavailable", message: "XRP pricing is temporarily unavailable. Please pay in RLUSD." },
        { status: 503 }
      );
    }
  }

  // Allocate a unique destination tag (retry on the rare collision).
  let invoice = null;
  for (let attempt = 0; attempt < 5 && !invoice; attempt++) {
    try {
      invoice = await prisma.invoice.create({
        data: {
          plan: plan.id,
          amountRlusd: plan.priceRlusd,
          currency,
          amountXrp: amountXrp ?? undefined,
          xrpUsdRate: xrpRate ?? undefined,
          destinationTag: randomTag(),
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

  const payAmount = currency === "XRP" ? amountXrp! : plan.priceRlusd;
  const pay =
    currency === "XRP"
      ? manualPayFieldsXrp(payAmount, invoice.destinationTag)
      : manualPayFields(payAmount, invoice.destinationTag);

  return NextResponse.json(
    {
      invoiceId: invoice.id,
      plan: plan.id,
      currency,
      priceUsd: plan.priceRlusd,
      amount: payAmount,
      amountRlusd: plan.priceRlusd,
      amountXrp,
      xrpUsdRate: xrpRate,
      expiresAt: invoice.expiresAt,
      pay,
      xamanDeeplink: xamanDeeplink(currency, payAmount, invoice.destinationTag),
      xamanAvailable: xummConfigured(),
      statusUrl: `/api/checkout/status?id=${invoice.id}`,
    },
    { status: 201 }
  );
}

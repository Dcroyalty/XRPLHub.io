// app/api/checkout/xaman/route.ts
// POST { invoiceId } -> a Xaman sign request pre-filled with the EXACT invoice
// payment: amount, currency, treasury Destination, and the invoice's unique
// DestinationTag. The buyer signs; Xaman submits. No address or tag typing.
//
// The authoritative confirmation stays /api/checkout/status (on-ledger match +
// key mint). This route only opens the payload.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { createPayload, xummConfigured, XummRateLimitError } from "@/lib/xumm";
import { RLUSD_ISSUER, RLUSD_CURRENCY_HEX, TREASURY_ADDRESS } from "@/lib/rlusd";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!TREASURY_ADDRESS) {
    return NextResponse.json({ error: "misconfigured" }, { status: 500 });
  }
  if (!xummConfigured()) {
    return NextResponse.json(
      { error: "xaman_unavailable", message: "Wallet connect is unavailable — pay manually below." },
      { status: 503 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as { invoiceId?: string };
  if (!body.invoiceId) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const invoice = await prisma.invoice.findUnique({ where: { id: body.invoiceId } });
  if (!invoice) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (invoice.status !== "pending") {
    return NextResponse.json({ error: "not_pending", status: invoice.status }, { status: 409 });
  }
  if (invoice.expiresAt < new Date()) {
    return NextResponse.json({ error: "expired" }, { status: 409 });
  }

  const isXrp = invoice.currency === "XRP";
  const amount = isXrp ? Number(invoice.amountXrp) : Number(invoice.amountRlusd);
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: "bad_invoice" }, { status: 422 });
  }

  const txjson: Record<string, unknown> = {
    TransactionType: "Payment",
    Destination: TREASURY_ADDRESS,
    DestinationTag: invoice.destinationTag,
    Amount: isXrp
      ? String(Math.round(amount * 1_000_000))
      : { currency: RLUSD_CURRENCY_HEX, issuer: RLUSD_ISSUER, value: String(amount) },
  };

  try {
    const p = await createPayload({
      txjson,
      identifier: `xrplhub_ckout_${invoice.id}`,
      blob: { invoiceId: invoice.id, plan: invoice.plan },
      instruction: `XRPLHub — ${invoice.plan} plan\n${amount} ${invoice.currency} → API key`,
      expireMinutes: 15,
    });
    return NextResponse.json({
      uuid: p.uuid,
      qrPng: p.qrPng,
      deepLink: p.deepLink,
      expiresIn: p.expiresIn,
    });
  } catch (e) {
    if (e instanceof XummRateLimitError) {
      return NextResponse.json(
        { error: "rate_limited", message: "Xaman is busy — try again in a moment or pay manually." },
        { status: 429 }
      );
    }
    console.error("[checkout/xaman]", e);
    return NextResponse.json(
      { error: "xaman_error", message: "Could not open Xaman — pay manually below." },
      { status: 502 }
    );
  }
}

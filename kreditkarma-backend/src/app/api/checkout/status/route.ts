// app/api/checkout/status/route.ts
// GET /api/checkout/status?id=INVOICE_ID
// Polls the ledger for a matching payment. On first match: marks the invoice
// paid, mints the API key, returns it ONCE. Idempotent — polling again after
// payment returns { status: "paid" } without minting a second key.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { findPayment } from "@/lib/rlusd";
import { generateApiKey } from "@/lib/keys";
import { PLAN_KEY_TTL_DAYS } from "@/lib/plans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const invoice = await prisma.invoice.findUnique({ where: { id }, include: { apiKey: true } });
  if (!invoice) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Already settled — don't hit the ledger again, don't mint twice. The raw
  // key was shown once at first confirmation; re-polls get status + expiry.
  if (invoice.status === "paid") {
    return NextResponse.json({
      status: "paid",
      paidAt: invoice.paidAt,
      plan: invoice.plan,
      expiresAt: invoice.apiKey?.expiresAt ?? null,
    });
  }

  // Expired and still unpaid.
  if (invoice.expiresAt < new Date()) {
    if (invoice.status !== "expired") {
      await prisma.invoice.update({
        where: { id },
        data: { status: "expired" },
      });
    }
    return NextResponse.json({ status: "expired" });
  }

  // Ask the ledger, in the currency this invoice was quoted in.
  const isXrp = invoice.currency === "XRP";
  const expected = isXrp ? Number(invoice.amountXrp) : Number(invoice.amountRlusd);
  const match = await findPayment(invoice.destinationTag, expected, {
    currency: isXrp ? "XRP" : "RLUSD",
  });

  if (!match.paid) {
    return NextResponse.json({ status: "pending" });
  }

  // First confirmation: mint the key and mark paid in one shot.
  const gen = generateApiKey();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PLAN_KEY_TTL_DAYS * 86_400_000);
  const updated = await prisma.invoice.update({
    where: { id, status: "pending" }, // guard against double-mint on races
    data: {
      status: "paid",
      txHash: match.txHash,
      deliveredRlusd: match.deliveredRlusd ?? undefined,
      deliveredXrp: match.deliveredXrp ?? undefined,
      paidAt: now,
      apiKey: {
        create: {
          keyPrefix: gen.keyPrefix,
          keyHash: gen.keyHash,
          name: `invoice:${invoice.id}`,
          plan: invoice.plan,
          expiresAt,
        },
      },
    },
    include: { apiKey: true },
  }).catch(() => null);

  // If the guarded update lost a race, someone else already flipped it.
  if (!updated) {
    return NextResponse.json({ status: "paid" });
  }

  return NextResponse.json({
    status: "paid",
    plan: invoice.plan,
    currency: invoice.currency,
    txHash: match.txHash,
    delivered: isXrp ? match.deliveredXrp : match.deliveredRlusd,
    key: gen.full, // shown ONCE
    expiresAt: expiresAt.toISOString(),
    termDays: PLAN_KEY_TTL_DAYS,
    note: `Store this key now — it cannot be shown again. It works for ${PLAN_KEY_TTL_DAYS} days (until ${expiresAt.toISOString()}); buy another to continue.`,
  });
}

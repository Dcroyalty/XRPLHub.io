// app/api/checkout/status/route.ts
// GET /api/checkout/status?id=INVOICE_ID
// Polls the ledger for a matching payment. On first match: marks the invoice
// paid, mints the API key, returns it ONCE. Idempotent — polling again after
// payment returns { status: "paid" } without minting a second key.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { findPayment } from "@/lib/rlusd";
import { generateApiKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const invoice = await prisma.invoice.findUnique({ where: { id } });
  if (!invoice) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Already settled — don't hit the ledger again, don't mint twice.
  if (invoice.status === "paid") {
    return NextResponse.json({ status: "paid", paidAt: invoice.paidAt });
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

  // Ask the ledger. Reads meta.delivered_amount under the hood.
  const match = await findPayment(
    invoice.destinationTag,
    Number(invoice.amountRlusd)
  );

  if (!match.paid) {
    return NextResponse.json({ status: "pending" });
  }

  // First confirmation: mint the key and mark paid in one shot.
  const gen = generateApiKey();
  const updated = await prisma.invoice.update({
    where: { id, status: "pending" }, // guard against double-mint on races
    data: {
      status: "paid",
      txHash: match.txHash,
      deliveredRlusd: match.deliveredRlusd,
      paidAt: new Date(),
      apiKey: {
        create: {
          keyPrefix: gen.keyPrefix,
          keyHash: gen.keyHash,
          name: `invoice:${invoice.id}`,
          plan: invoice.plan,
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
    txHash: match.txHash,
    delivered: match.deliveredRlusd,
    key: gen.full, // shown ONCE
    note: "Store this key now. It cannot be shown again.",
  });
}

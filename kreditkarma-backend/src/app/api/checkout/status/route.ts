// app/api/checkout/status/route.ts
// GET /api/checkout/status?id=INVOICE_ID[&hash=TXHASH][&uuid=XAMAN_PAYLOAD_UUID]
// Looks for the invoice's payment on the ledger. On first match: marks the invoice
// paid, mints the API key, returns it ONCE. Idempotent — polling again after
// payment returns { status: "paid" } without minting a second key.
//
// HOW THE PAYMENT IS FOUND (see findPayment in src/lib/rlusd.ts): by the exact transaction hash when the
// caller (or the Xaman payload we created for this invoice) supplies one, otherwise by walking the treasury's
// history back to the invoice's creation time. Never a fixed-size window, so unrelated traffic (dust) cannot push a
// real payment out of view. An invoice is only declared expired after the ledger was read completely.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { findPayment, type PaymentMatch } from "@/lib/rlusd";
import { generateApiKey } from "@/lib/keys";
import { PLAN_KEY_TTL_DAYS } from "@/lib/plans";
import { getPayloadStatus, xummConfigured } from "@/lib/xumm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HASH_RE = /^[0-9A-Fa-f]{64}$/;

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const id = params.get("id");
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
  if (invoice.status === "expired") {
    return NextResponse.json({ status: "expired" });
  }

  const isXrp = invoice.currency === "XRP";
  const expected = isXrp ? Number(invoice.amountXrp) : Number(invoice.amountRlusd);
  const opts = {
    currency: (isXrp ? "XRP" : "RLUSD") as "XRP" | "RLUSD",
    since: invoice.createdAt,
    until: invoice.expiresAt,
  };

  // A hash the caller already knows: given directly, or read from the Xaman payload WE created for THIS invoice.
  let hintHash: string | null = HASH_RE.test(params.get("hash") ?? "") ? (params.get("hash") as string) : null;
  const uuid = params.get("uuid");
  if (!hintHash && uuid && xummConfigured()) {
    try {
      const s = await getPayloadStatus(uuid);
      if (s.state === "signed" && s.txid && s.identifier === `xrplhub_ckout_${invoice.id}` && HASH_RE.test(s.txid)) hintHash = s.txid;
    } catch {
      /* Xaman being slow never blocks the ledger check */
    }
  }

  // The ledger check runs even when the invoice is past its expiry: a payment that closed inside the invoice's
  // lifetime still counts (findPayment enforces the window). Only a COMPLETE read that finds nothing may expire it.
  let match: PaymentMatch = { paid: false, complete: false };
  if (hintHash) match = await findPayment(invoice.destinationTag, expected, { ...opts, txHash: hintHash });
  if (!match.paid) match = await findPayment(invoice.destinationTag, expected, opts);

  if (!match.paid) {
    if (invoice.expiresAt < new Date()) {
      if (!match.complete) {
        return NextResponse.json({
          status: "pending",
          note: "This invoice is past its expiry but the ledger could not be read completely, so it has not been closed. Keep this page open.",
        });
      }
      await prisma.invoice.updateMany({ where: { id, status: "pending" }, data: { status: "expired" } });
      return NextResponse.json({ status: "expired" });
    }
    return NextResponse.json({ status: "pending" });
  }

  // First confirmation: mint the key and mark paid in one shot.
  const gen = generateApiKey();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PLAN_KEY_TTL_DAYS * 86_400_000);
  let updated;
  try {
    updated = await prisma.invoice.update({
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
    });
  } catch (e) {
    // P2025 = no pending row matched: another request already flipped it (the race guard doing its job).
    if ((e as { code?: string })?.code === "P2025") return NextResponse.json({ status: "paid" });
    // Anything else is a database failure: the invoice is still pending, so say so and let the poll retry —
    // never tell a buyer "paid" without a key.
    console.error("[checkout/status] key mint failed", e);
    return NextResponse.json(
      { status: "pending", error: "retry", message: "Your payment was found on the ledger; issuing the key hit a temporary error. Retrying." },
      { status: 503 }
    );
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

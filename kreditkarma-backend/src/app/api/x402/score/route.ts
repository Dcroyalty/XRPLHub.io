// src/app/api/x402/score/route.ts
// XRPLScore over the OFFICIAL x402 v2 protocol (XRPL exact scheme, t54).
// Runs alongside the destination-tag endpoints. No custody.
//
// CRAWLER NOTE: a bare GET (no wallet, no PAYMENT-SIGNATURE) returns the 402
// PAYMENT-REQUIRED challenge so x402scan's param-less probe succeeds.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { computeScore, isValidXrplAddress } from "@/lib/engine";
import { PRICE_PER_SCORE_RLUSD, TREASURY_ADDRESS } from "@/lib/paycall";
import {
  X402_VERSION,
  decodeHeader,
  encodeHeader,
  paymentRequiredChallenge,
  rlusdRequirements,
  verifyPayment,
  settlePayment,
  looksSuccessful,
  type PaymentSignaturePayload,
} from "@/lib/x402";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESOURCE = "/api/x402/score";

async function issueChallenge(walletForDesc: string | null) {
  const invoice = await prisma.invoice.create({
    data: {
      plan: "x402:score",
      amountRlusd: PRICE_PER_SCORE_RLUSD,
      destinationTag: 1 + Math.floor(Math.random() * 4_294_967_294),
      status: "pending",
      expiresAt: new Date(Date.now() + 10 * 60_000),
    },
  });
  const requirements = rlusdRequirements({
    payTo: TREASURY_ADDRESS,
    amountRlusd: PRICE_PER_SCORE_RLUSD,
    invoiceId: invoice.id,
  });
  const challenge = paymentRequiredChallenge(
    requirements,
    RESOURCE,
    `XRPLScore 300-850 wallet risk score${walletForDesc ? " for " + walletForDesc : ""}`
  );
  return NextResponse.json(challenge, {
    status: 402,
    headers: { "PAYMENT-REQUIRED": encodeHeader(challenge), "Cache-Control": "no-store" },
  });
}

export async function GET(req: Request) {
  if (!TREASURY_ADDRESS) {
    return NextResponse.json({ error: "misconfigured" }, { status: 500 });
  }

  const url = new URL(req.url);
  const wallet = url.searchParams.get("wallet");
  const sigHeader = req.headers.get("PAYMENT-SIGNATURE");

  // ── No payment signature: issue the 402 challenge FIRST (crawler-safe) ──
  if (!sigHeader) {
    return issueChallenge(wallet);
  }

  // ── Payment presented: validate wallet, then verify + settle ────────────
  if (!wallet || !isValidXrplAddress(wallet)) {
    return NextResponse.json(
      { error: "bad_request", message: "Provide a valid XRPL wallet (&wallet=r...)." },
      { status: 400 }
    );
  }

  const payload = decodeHeader<PaymentSignaturePayload>(sigHeader);
  if (!payload || payload.x402Version !== X402_VERSION || !payload.accepted) {
    return NextResponse.json({ error: "invalid_payment_payload" }, { status: 400 });
  }

  const invoiceId = payload.accepted?.extra?.invoiceId;
  if (!invoiceId) {
    return NextResponse.json({ error: "invoice_binding_missing" }, { status: 400 });
  }

  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice || invoice.plan !== "x402:score") {
    return NextResponse.json({ error: "invoice_not_found" }, { status: 404 });
  }
  if (invoice.status === "paid") return deliver(wallet, invoice.txHash ?? undefined);
  if (invoice.expiresAt < new Date()) {
    return NextResponse.json({ error: "invoice_expired" }, { status: 410 });
  }

  const requirements = rlusdRequirements({
    payTo: TREASURY_ADDRESS,
    amountRlusd: Number(invoice.amountRlusd),
    invoiceId: invoice.id,
  });

  const verified = await verifyPayment(payload, requirements);
  if (!looksSuccessful(verified)) {
    return NextResponse.json(
      { error: "payment_verification_failed", facilitator: verified.body ?? verified.error ?? null, status: verified.status },
      { status: 402 }
    );
  }

  const settled = await settlePayment(payload, requirements);
  if (!looksSuccessful(settled)) {
    return NextResponse.json(
      { error: "settlement_failed", facilitator: settled.body ?? settled.error ?? null, status: settled.status },
      { status: 402 }
    );
  }

  const b = (settled.body ?? {}) as { transaction?: string; payer?: string };
  await prisma.invoice.update({
    where: { id: invoice.id, status: "pending" },
    data: {
      status: "paid", txHash: b.transaction ?? null,
      deliveredRlusd: invoice.amountRlusd, paidAt: new Date(),
    },
  }).catch(() => {});

  return deliver(wallet, b.transaction, b.payer);
}

async function deliver(wallet: string, txHash?: string, payer?: string) {
  try {
    const result = await computeScore(wallet);
    const paymentResponse = {
      success: true, transaction: txHash ?? null,
      network: process.env.X402_NETWORK ?? "xrpl:0", payer: payer ?? null,
    };
    return NextResponse.json(
      { data: result, x402: paymentResponse },
      {
        status: 200,
        headers: { "PAYMENT-RESPONSE": encodeHeader(paymentResponse), "Cache-Control": "private, max-age=60" },
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "scoring failed";
    return NextResponse.json({ error: "scoring_failed", message }, { status: 500 });
  }
}

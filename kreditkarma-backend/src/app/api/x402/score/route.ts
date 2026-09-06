// src/app/api/x402/score/route.ts
// XRPLScore over the OFFICIAL x402 v2 protocol (XRPL exact scheme, t54).
// Runs alongside the destination-tag endpoints. No custody.
//
// CRAWLER NOTE: a bare GET (no wallet, no PAYMENT-SIGNATURE) returns the 402
// PAYMENT-REQUIRED challenge so x402scan / xrpl-ai.org probes succeed.
//
// SPAM FIX: the challenge is STATELESS â€” no invoice row is created for a probe.
// A row is written only after a payment settles (see recordPaidInvoice).

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
  reportFacilitatorFault,
  statelessInvoiceId,
  recordPaidInvoice,
  type PaymentSignaturePayload,
} from "@/lib/x402";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESOURCE = "/api/x402/score";

function issueChallenge(walletForDesc: string | null) {
  const invoiceId = statelessInvoiceId("x402:score");
  const requirements = rlusdRequirements({
    payTo: TREASURY_ADDRESS,
    amountRlusd: PRICE_PER_SCORE_RLUSD,
    invoiceId,
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

  // No payment signature: issue the 402 challenge FIRST (crawler-safe).
  if (!sigHeader) {
    return issueChallenge(wallet);
  }

  // Payment presented: validate wallet, then verify + settle.
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

  // Rebuild requirements server-side from OUR price + the echoed invoiceId. The
  // facilitator enforces that the on-ledger payment matches these exactly (exact
  // scheme, our treasury), so no pre-stored invoice row is needed.
  const requirements = rlusdRequirements({
    payTo: TREASURY_ADDRESS,
    amountRlusd: PRICE_PER_SCORE_RLUSD,
    invoiceId,
  });

  const verified = await verifyPayment(payload, requirements);
  if (!looksSuccessful(verified)) {
    reportFacilitatorFault("verify", verified, { resource: RESOURCE, wallet, invoiceId });
    return NextResponse.json(
      { error: "payment_verification_failed", facilitator: verified.body ?? verified.error ?? null, status: verified.status },
      { status: 402 }
    );
  }

  const settled = await settlePayment(payload, requirements);
  if (!looksSuccessful(settled)) {
    reportFacilitatorFault("settle", settled, { resource: RESOURCE, wallet, invoiceId });
    return NextResponse.json(
      { error: "settlement_failed", facilitator: settled.body ?? settled.error ?? null, status: settled.status },
      { status: 402 }
    );
  }

  const b = (settled.body ?? {}) as { transaction?: string; payer?: string };
  // Persist a row ONLY now that payment settled (probes never reach here).
  await recordPaidInvoice(prisma, { plan: "x402:score", amountRlusd: PRICE_PER_SCORE_RLUSD, txHash: b.transaction });

  return deliver(wallet, b.transaction, b.payer);
}

async function deliver(wallet: string, txHash?: string, payer?: string) {
  try {
    const result = await computeScore(wallet);
    const paymentResponse = {
      success: true, transaction: txHash ?? null,
      network: process.env.X402_NETWORK ?? "xrpl", payer: payer ?? null,
    };
    return NextResponse.json(
      { data: result, x402: paymentResponse },
      { status: 200, headers: { "PAYMENT-RESPONSE": encodeHeader(paymentResponse), "Cache-Control": "private, max-age=60" } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "scoring failed";
    return NextResponse.json({ error: "scoring_failed", message }, { status: 500 });
  }
}

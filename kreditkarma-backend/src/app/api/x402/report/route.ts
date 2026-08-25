// src/app/api/x402/report/route.ts
// Full Wallet Risk Report over the OFFICIAL x402 v2 protocol (t54, XRPL).
// Standard PAYMENT-REQUIRED header so xrpl-ai.org auto-discovers + lists it.
// Runs alongside /api/v1/wallet-report (destination-tag flow, untouched).
//
// SPAM FIX: stateless challenge â€” no invoice row for a probe; a row is written
// only after a payment settles.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { isValidXrplAddress } from "@/lib/engine";
import { buildWalletReport } from "@/lib/report";
import { PRICE_PER_PRODUCT_RLUSD, TREASURY_ADDRESS } from "@/lib/paycall";
import {
  X402_VERSION,
  decodeHeader,
  encodeHeader,
  paymentRequiredChallenge,
  rlusdRequirements,
  verifyPayment,
  settlePayment,
  looksSuccessful,
  statelessInvoiceId,
  recordPaidInvoice,
  type PaymentSignaturePayload,
} from "@/lib/x402";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESOURCE = "/api/x402/report";

const NAME = "XRPLHub â€” Full Wallet Risk Report";
const DESC =
  "Score plus machine-readable risk flags, weighted signal detail, and an on-chain " +
  "snapshot (balance, trust lines, activity, counterparties). Pay per call in RLUSD.";

function issueChallenge() {
  const invoiceId = statelessInvoiceId("x402:report");
  const requirements = rlusdRequirements({
    payTo: TREASURY_ADDRESS,
    amountRlusd: PRICE_PER_PRODUCT_RLUSD,
    invoiceId,
    name: NAME,
    description: DESC,
  });
  const challenge = paymentRequiredChallenge(requirements, RESOURCE, DESC);
  return NextResponse.json(challenge, {
    status: 402,
    headers: { "PAYMENT-REQUIRED": encodeHeader(challenge), "Cache-Control": "no-store" },
  });
}

export async function GET(req: Request) {
  if (!TREASURY_ADDRESS) return NextResponse.json({ error: "misconfigured" }, { status: 500 });

  const url = new URL(req.url);
  const wallet = url.searchParams.get("wallet");
  const sigHeader = req.headers.get("PAYMENT-SIGNATURE");

  if (!sigHeader) return issueChallenge();

  if (!wallet || !isValidXrplAddress(wallet)) {
    return NextResponse.json({ error: "bad_request", message: "Provide &wallet=r..." }, { status: 400 });
  }

  const payload = decodeHeader<PaymentSignaturePayload>(sigHeader);
  if (!payload || payload.x402Version !== X402_VERSION || !payload.accepted) {
    return NextResponse.json({ error: "invalid_payment_payload" }, { status: 400 });
  }
  const invoiceId = payload.accepted?.extra?.invoiceId;
  if (!invoiceId) return NextResponse.json({ error: "invoice_binding_missing" }, { status: 400 });

  // Rebuild requirements server-side from OUR price + echoed invoiceId; the
  // facilitator enforces the on-ledger payment matches. No stored row needed.
  const requirements = rlusdRequirements({
    payTo: TREASURY_ADDRESS,
    amountRlusd: PRICE_PER_PRODUCT_RLUSD,
    invoiceId,
    name: NAME,
    description: DESC,
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
  await recordPaidInvoice(prisma, { plan: "x402:report", amountRlusd: PRICE_PER_PRODUCT_RLUSD, txHash: b.transaction });

  return deliver(wallet, b.transaction, b.payer);
}

async function deliver(wallet: string, txHash?: string, payer?: string) {
  try {
    const report = await buildWalletReport(wallet);
    const paymentResponse = { success: true, transaction: txHash ?? null, network: process.env.X402_NETWORK ?? "xrpl", payer: payer ?? null };
    return NextResponse.json(
      { data: report, x402: paymentResponse },
      { status: 200, headers: { "PAYMENT-RESPONSE": encodeHeader(paymentResponse), "Cache-Control": "private, max-age=60" } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "report failed";
    return NextResponse.json({ error: "report_failed", message }, { status: 500 });
  }
}

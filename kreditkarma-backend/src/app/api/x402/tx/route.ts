// src/app/api/x402/tx/route.ts
// Prebuilt XRPL transaction (27 services) over the OFFICIAL x402 v2 protocol.
// Standard PAYMENT-REQUIRED header so xrpl-ai.org auto-discovers + lists it.
// Runs alongside /api/x402-tx (destination-tag flow, untouched).
//
// productId + account come as query params; on paid retry we build the txjson
// with the existing buildServiceTx engine. Bare probe -> 402 (defaults to
// checkcreate so the crawler gets a valid challenge).
//
// SPAM FIX: stateless challenge â€” no invoice row for a probe; a row is written
// only after a payment settles.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { PRICE_PER_TX_PRODUCT_RLUSD, TREASURY_ADDRESS } from "@/lib/paycall";
import { buildServiceTx } from "@/app/api/execute/txBuilder";
import { BUILDABLE_SERVICE_IDS } from "@/app/api/execute/serviceCatalog";
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

const RESOURCE = "/api/x402/tx";
const isAddr = (v: string) => v.startsWith("r") && v.length >= 25 && v.length <= 35;

const KNOWN = new Set(BUILDABLE_SERVICE_IDS);

const NAME = "XRPLHub — Prebuilt XRPL Transaction";
const DESC =
  "Get a ready-to-sign XRPL transaction JSON for any of 35 actions — CheckCreate, Escrow, TrustSet, " +
  "NFT mint/sell/burn, AMM create/deposit, DEX order, MPT issue/send, multisig, DID, credentials, " +
  "permissioned domains, and more. Send ?productId=<id>&account=r<signer>; get back the exact txjson " +
  "plus a safety tier. You sign it with your own wallet. Pay per call in RLUSD, no signup.";

function extractParams(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) {
    if (["productId", "account"].includes(k)) continue;
    out[k] = v;
  }
  return out;
}

function issueChallenge(productId: string) {
  const invoiceId = statelessInvoiceId(`x402:tx:${productId}`);
  const requirements = rlusdRequirements({
    payTo: TREASURY_ADDRESS,
    amountRlusd: PRICE_PER_TX_PRODUCT_RLUSD,
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
  const productId = (url.searchParams.get("productId") ?? "checkcreate").toLowerCase();
  const account = url.searchParams.get("account");
  const sigHeader = req.headers.get("PAYMENT-SIGNATURE");

  if (!KNOWN.has(productId)) {
    return NextResponse.json({ error: "unknown_product", message: `No product "${productId}".` }, { status: 404 });
  }

  if (!sigHeader) return issueChallenge(productId);

  if (!account || !isAddr(account)) {
    return NextResponse.json({ error: "bad_request", message: "Provide &account=r... (the signer)." }, { status: 400 });
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
    amountRlusd: PRICE_PER_TX_PRODUCT_RLUSD,
    invoiceId,
    name: NAME,
    description: DESC,
  });
  const verified = await verifyPayment(payload, requirements);
  if (!looksSuccessful(verified)) {
    reportFacilitatorFault("verify", verified, { resource: "/api/x402/tx", invoiceId });
    return NextResponse.json(
      { error: "payment_verification_failed", facilitator: verified.body ?? verified.error ?? null, status: verified.status },
      { status: 402 }
    );
  }
  const settled = await settlePayment(payload, requirements);
  if (!looksSuccessful(settled)) {
    reportFacilitatorFault("settle", settled, { resource: "/api/x402/tx", invoiceId });
    return NextResponse.json(
      { error: "settlement_failed", facilitator: settled.body ?? settled.error ?? null, status: settled.status },
      { status: 402 }
    );
  }
  const b = (settled.body ?? {}) as { transaction?: string };
  await recordPaidInvoice(prisma, { plan: `x402:tx:${productId}`, amountRlusd: PRICE_PER_TX_PRODUCT_RLUSD, txHash: b.transaction });

  const built = buildServiceTx(productId, account, extractParams(url));
  if (!built.ok) {
    return NextResponse.json(
      { error: "build_failed", reason: built.error, needsParams: built.needsParams ?? [], tier: built.tier ?? null,
        note: "Payment received. Retry with the missing params." },
      { status: 422 }
    );
  }

  const paymentResponse = { success: true, network: process.env.X402_NETWORK ?? "xrpl" };
  return NextResponse.json(
    {
      data: {
        productId, label: built.label ?? productId, tier: built.tier ?? "safe",
        txjson: built.txjson, signWith: account,
        instructions: "Sign this txjson with your own XRPL wallet and submit it.",
      },
      x402: paymentResponse,
    },
    { status: 200, headers: { "PAYMENT-RESPONSE": encodeHeader(paymentResponse), "Cache-Control": "no-store" } }
  );
}

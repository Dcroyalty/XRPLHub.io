// src/app/api/x402/lending/exposure/route.ts
// XLS-66 cross-broker lending exposure — full detail, paid: $0.01 USDC on Base
// via x402. Everything /api/lending/exposure returns PLUS every loan decoded, the
// per-broker first-loss context (the counterparty broker's own DebtTotal /
// CoverAvailable), the last-known state of every vanished loan, and the
// Merkle-anchored attestation receipt.
//
// Same withX402 v1 wrapper as /api/x402/usdc/{score,mpt} and /api/x402/screen/ofac
// — settles only after the handler returns success.
//
// Persists an immutable LendingExposureSnapshot like the free route. Pre-activation
// the handler returns 503 (the x402 layer does not settle a non-2xx).

import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "x402-next";
import { createHash } from "crypto";
import { BASE_PAY_TO, BASE_NETWORK, PRICE_PER_EXPOSURE_USDC, cdpFacilitator } from "@/lib/x402Base";
import { dualX402 } from "@/lib/x402Dual";
import { PRICE_PER_EXPOSURE_RLUSD } from "@/lib/paycall";
import { prisma } from "@/lib/xrplscore-db";
import {
  runExposureQuery,
  isValidXrplAddress,
  LENDING_EXPOSURE_DESCRIPTION,
  LENDING_EXPOSURE_INPUT_SCHEMA,
  LENDING_EXPOSURE_OUTPUT_SCHEMA,
} from "@/lib/lendingExposure";
import { LENDING_PROTOCOL_AMENDMENT_ID } from "@/lib/lendingLedger";
import { XrplUnavailableError } from "@/lib/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VERIFY_BASE = "https://www.xrplhub.io/api/attest/verify?queryId=";

const handler = async (req: NextRequest): Promise<NextResponse<unknown>> => {
  const borrower = (req.nextUrl.searchParams.get("borrower") ?? "").trim();
  if (!isValidXrplAddress(borrower)) {
    return NextResponse.json({ error: "bad_request", message: "Provide a valid XRPL address: ?borrower=r..." }, { status: 400 });
  }

  // Base rail pays with X-PAYMENT, the XRPL rail with PAYMENT-SIGNATURE (src/lib/x402Dual.ts).
  const pay = req.headers.get("x-payment") ?? req.headers.get("payment-signature") ?? "";
  const payId = pay ? createHash("sha256").update(pay).digest("hex").slice(0, 16) : "base-usdc";

  try {
    const out = await runExposureQuery(prisma, borrower, `x402:${payId}`);

    if (!out.amendmentActive) {
      return NextResponse.json(
        {
          status: "amendment-not-active",
          amendment: "LendingProtocol",
          amendmentId: LENDING_PROTOCOL_AMENDMENT_ID,
          message: "XLS-66 is not yet enabled on mainnet. This endpoint serves automatically on activation.",
          borrower: out.borrower,
          xrplScore: out.xrplScore,
          grade: out.grade,
          observation: out.observation,
          disclaimer: out.disclaimer,
        },
        { status: 503 }
      );
    }

    return NextResponse.json({
      borrower: out.borrower,
      amendmentActive: true,
      ledgerIndex: out.ledgerIndex,
      ledgerCloseAt: out.ledgerCloseAt,
      asOf: out.generatedAt,
      disposition: out.disposition,
      exposure: out.exposure,
      events: out.events,
      worstStatus: out.worstStatus,
      earliestNextPaymentDue: out.earliestNextPaymentDue,
      xrplScore: out.xrplScore,
      grade: out.grade,
      observation: out.observation,
      loans: out.loans,
      brokers: out.brokers,
      vanishedLoans: out.vanishedLoans,
      attestation: {
        queryId: out.queryId,
        canonVersion: "lending-exposure-v1",
        engineVersion: "lending-exposure-v1",
        leafHash: out.leafHash,
        verify: `${VERIFY_BASE}${out.queryId}`,
      },
      disclaimer: out.disclaimer,
    });
  } catch (err) {
    if (err instanceof XrplUnavailableError) {
      // Not scored, nothing persisted or attested, not settled (non-2xx). Retryable.
      return NextResponse.json(
        { error: "xrpl_unavailable", message: err.message, failedCalls: err.failedCalls, retryable: true },
        { status: 503, headers: { "Retry-After": "15" } }
      );
    }
    return NextResponse.json(
      { error: "exposure_failed", message: err instanceof Error ? err.message : "exposure query failed" },
      { status: 502 }
    );
  }
};

const paidGET = withX402(
  handler,
  BASE_PAY_TO,
  {
    price: `$${PRICE_PER_EXPOSURE_USDC}`,
    network: BASE_NETWORK,
    config: {
      description: LENDING_EXPOSURE_DESCRIPTION,
      mimeType: "application/json",
      discoverable: true,
      outputSchema: LENDING_EXPOSURE_OUTPUT_SCHEMA,
    },
  },
  cdpFacilitator
);

// A MISTYPED address is refused BEFORE the payment challenge: no 402 to pay against, no receipt, no attestation, no charge.
// A bare request (no address) still gets the 402 challenge, so x402 discovery crawlers can index the route.
// (The handler above re-checks it too; that check alone runs only after the payment was verified.)
const refuse = (req: NextRequest): Response | null => {
  const supplied = (req.nextUrl.searchParams.get("borrower") ?? "").trim();
  if (supplied && !isValidXrplAddress(supplied)) {
    return NextResponse.json(
      { error: "bad_request", message: "Provide a valid XRPL borrower (?borrower=r...) — an r-address whose checksum verifies. Nothing was screened, priced or charged." },
      { status: 400 }
    );
  }
  return null;
};

// Payable on BOTH rails at the same price: USDC on Base (X-PAYMENT, CDP) or RLUSD on XRPL (PAYMENT-SIGNATURE, t54).
export const GET = dualX402({
  resource: "/api/x402/lending/exposure",
  plan: "x402:lending-exposure",
  amountRlusd: PRICE_PER_EXPOSURE_RLUSD,
  amountUsdc: PRICE_PER_EXPOSURE_USDC,
  name: "XLS-66 cross-broker lending exposure (full)",
  description: LENDING_EXPOSURE_DESCRIPTION,
  schemas: {
    input: { type: "object", properties: { borrower: LENDING_EXPOSURE_INPUT_SCHEMA.properties.borrower }, required: ["borrower"] },
    output: LENDING_EXPOSURE_OUTPUT_SCHEMA,
  },
  base: paidGET,
  core: handler,
  refuse,
});

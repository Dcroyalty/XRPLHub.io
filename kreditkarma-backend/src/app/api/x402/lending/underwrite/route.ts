// src/app/api/x402/lending/underwrite/route.ts
// GET /api/x402/lending/underwrite?borrower=r...  — $0.05 USDC on Base (x402).
//
// One call, every input a LoanBroker needs for an underwriting decision, as
// FACTS: cross-broker exposure, XRPLScore + grade, OFAC SDN screening result
// with its own receipt, observation history + gaps, and ONE attestation over
// the whole bundle. NO recommendation — no principal, no rate, no
// approve/decline, no PD. x402-only, no free tier, no API-key path.
//
// Same withX402 v1 wrapper as the other CDP routes — settles only after the
// handler returns success. Amendment-gated like /api/lending/exposure: 503
// (still carrying the live XRPLScore + OFAC result) until XLS-66 enables.

import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "x402-next";
import { BASE_PAY_TO, BASE_NETWORK, PRICE_PER_UNDERWRITE_USDC, cdpFacilitator } from "@/lib/x402Base";
import { prisma } from "@/lib/xrplscore-db";
import { runUnderwriteBundle, isValidXrplAddress } from "@/lib/underwriteBundle";
import { UNDERWRITE_DISCLAIMER } from "@/lib/underwriteCanon";
import { XrplUnavailableError } from "@/lib/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DESCRIPTION =
  "Every input a LoanBroker needs for an XLS-66 underwriting decision in one call: cross-broker exposure, " +
  "XRPLScore + grade, OFAC SDN screening (with its own verifiable receipt), observation history + gaps, and " +
  "one Merkle-anchored attestation over the whole bundle. FACTS ONLY — no recommended principal, rate, " +
  "approve/decline, or probability of default. The broker decides. Not lending or underwriting advice. " +
  "Amendment-gated: 503 (with the live XRPLScore) until XLS-66 enables.";

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    borrower: { type: "string" },
    amendmentActive: { type: "boolean" },
    ledgerIndex: { type: "integer" },
    exposure: {
      type: "object",
      nullable: true,
      properties: {
        byAsset: { type: "object", additionalProperties: { type: "object" } },
        loanCount: { type: "integer" },
        brokerCount: { type: "integer" },
      },
    },
    events: { type: "object", properties: { defaulted: { type: "integer" }, impaired: { type: "integer" }, overdue: { type: "integer" }, overdueGraceExpired: { type: "integer" } } },
    worstStatus: { type: "string" },
    score: { type: "object", properties: { xrplScore: { type: "integer", nullable: true }, grade: { type: "string", nullable: true }, methodology: { type: "string" } } },
    screening: {
      type: "object",
      description: "OFAC SDN factual comparison. `listed:false` is NOT a statement that the address is clean or unsanctioned. Its own receipt (receiptQueryId) is independently verifiable at /api/attest/verify.",
      properties: {
        available: { type: "boolean" },
        listed: { type: "boolean" },
        list: { type: "object", properties: { name: { type: "string" }, vintage: { type: "string" }, sha256: { type: "string" } } },
        statement: { type: "string" },
        receiptQueryId: { type: "string" },
        receiptLeafHash: { type: "string" },
      },
    },
    observationHistory: {
      type: "object",
      properties: {
        everObservedLoans: { type: "boolean" },
        firstObservedAt: { type: "string", format: "date-time", nullable: true },
        vanished: { type: "integer" },
        vanishedLastSeenDefaultedOrImpaired: { type: "integer" },
        sweepCoverage: { type: "object", description: "when this borrower was last swept + any observation gaps" },
      },
    },
    attestation: {
      type: "object",
      nullable: true,
      properties: {
        queryId: { type: "string" },
        canonVersion: { type: "string", enum: ["underwrite-bundle-v1"] },
        leafHash: { type: "string" },
        components: { type: "object", properties: { exposureQueryId: { type: "string", nullable: true }, screeningQueryId: { type: "string", nullable: true } } },
        verify: { type: "string" },
      },
    },
    disclaimer: { type: "string" },
  },
  required: ["borrower", "amendmentActive", "events", "worstStatus", "score", "screening", "observationHistory", "disclaimer"],
} as const;

const handler = async (req: NextRequest): Promise<NextResponse<unknown>> => {
  const borrower = (req.nextUrl.searchParams.get("borrower") ?? "").trim();
  if (!isValidXrplAddress(borrower)) {
    return NextResponse.json({ error: "bad_request", message: "Provide a valid XRPL address: ?borrower=r..." }, { status: 400 });
  }
  try {
    const out = await runUnderwriteBundle(prisma, borrower, "underwrite");
    if (!out.amendmentActive) {
      return NextResponse.json(
        {
          status: "amendment-not-active",
          amendment: "LendingProtocol",
          amendmentId: out.amendmentId,
          message: "XLS-66 is not yet enabled on mainnet. The XRPLScore and OFAC screening below are live.",
          borrower: out.borrower,
          score: out.score,
          screening: out.screening,
          observationHistory: out.observationHistory,
          disclaimer: out.disclaimer,
        },
        { status: 503 }
      );
    }
    return NextResponse.json(out);
  } catch (err) {
    if (err instanceof XrplUnavailableError) {
      // The bundle's XRPLScore input could not be read — no bundle, no
      // attestation, nothing anchored, not settled (non-2xx). Retryable.
      return NextResponse.json(
        { error: "xrpl_unavailable", message: err.message, failedCalls: err.failedCalls, retryable: true, disclaimer: UNDERWRITE_DISCLAIMER },
        { status: 503, headers: { "Retry-After": "15" } }
      );
    }
    return NextResponse.json(
      { error: "underwrite_failed", message: err instanceof Error ? err.message : "bundle failed", disclaimer: UNDERWRITE_DISCLAIMER },
      { status: 502 }
    );
  }
};

export const GET = withX402(
  handler,
  BASE_PAY_TO,
  {
    price: `$${PRICE_PER_UNDERWRITE_USDC}`,
    network: BASE_NETWORK,
    config: {
      description: DESCRIPTION,
      mimeType: "application/json",
      discoverable: true,
      outputSchema: OUTPUT_SCHEMA,
    },
  },
  cdpFacilitator
);

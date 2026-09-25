// src/app/api/x402/screen/ofac/route.ts
// OFAC SDN screening attestation over x402: $0.01 USDC on Base, per call.
// The API-key route at /api/screen/ofac stays free for key holders (free tier
// included) — this is the no-signup, pay-per-call variant for agents.
//
// Same withX402 v1 wrapper as /api/x402/usdc/score: settles only after the
// handler returns success. See src/lib/x402Base.ts for the pinning rationale.
//
// This attests to PROCESS, never ground truth: it records that the address was
// compared against a named OFAC SDN snapshot at a stated time and what the
// comparison found — never that the address is sanctioned, clean, or risky.
import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "x402-next";
import { createHash } from "crypto";
import { BASE_PAY_TO, BASE_NETWORK, PRICE_PER_SCREEN_USDC, cdpFacilitator } from "@/lib/x402Base";
import { dualX402 } from "@/lib/x402Dual";
import { PRICE_PER_SCREEN_RLUSD } from "@/lib/paycall";
import { prisma } from "@/lib/xrplscore-db";
import { isValidXrplAddress } from "@/lib/engine";
import {
  screenOfac,
  NoSnapshotError,
  SCREEN_DISCLAIMER_SHORT,
  SCREEN_OFAC_DESCRIPTION,
  SCREEN_OFAC_INPUT_SCHEMA,
  SCREEN_OFAC_OUTPUT_SCHEMA,
  SCREEN_OFAC_OUTPUT_EXAMPLE,
} from "@/lib/screen";
import { SCREEN_CANON_VERSION } from "@/lib/screenCanon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VERIFY_BASE = "https://www.xrplhub.io/api/attest/verify?queryId=";

const handler = async (req: NextRequest): Promise<NextResponse<unknown>> => {
  const address = (req.nextUrl.searchParams.get("address") ?? "").trim();
  if (!isValidXrplAddress(address)) {
    return NextResponse.json(
      { error: "bad_request", message: "Provide a valid XRPL address: ?address=r..." },
      { status: 400 }
    );
  }

  // Stable per-payment id for the receipt (no PII, no key needed): a hash of the
  // presented x402 payment header. Falls back to "base-usdc" if absent.
  const pay = req.headers.get("x-payment") ?? req.headers.get("payment-signature") ?? "";
  const payId = pay ? createHash("sha256").update(pay).digest("hex").slice(0, 16) : "base-usdc";

  try {
    const out = await screenOfac(prisma, address, `x402:${payId}`);
    return NextResponse.json({
      attestation: {
        queryId: out.queryId,
        canonVersion: SCREEN_CANON_VERSION,
        engineVersion: out.leaf.engineVersion,
        leafHash: out.leafHash,
        verify: `${VERIFY_BASE}${out.queryId}`,
      },
      subject: out.leaf.subjectAddress,
      screenedAt: out.leaf.screenedAt,
      method: "exact-match",
      ledgerIndex: out.leaf.ledgerIndex,
      lists: out.leaf.lists,
      result: out.leaf.result,
      statement: out.statement,
      canonicalLeaf: out.canonicalJson,
      disclaimer: SCREEN_DISCLAIMER_SHORT,
    });
  } catch (err) {
    if (err instanceof NoSnapshotError) {
      return NextResponse.json({ error: "not_ready", message: err.message }, { status: 503 });
    }
    return NextResponse.json(
      { error: "screen_failed", message: err instanceof Error ? err.message : "screen failed" },
      { status: 502 }
    );
  }
};

const paidGET = withX402(
  handler,
  BASE_PAY_TO,
  {
    price: `$${PRICE_PER_SCREEN_USDC}`,
    network: BASE_NETWORK,
    config: {
      description: SCREEN_OFAC_DESCRIPTION,
      mimeType: "application/json",
      discoverable: true,
      outputSchema: SCREEN_OFAC_OUTPUT_SCHEMA,
    },
  },
  cdpFacilitator
);

// A MISTYPED address is refused BEFORE the payment challenge: no 402 to pay against, no receipt, no attestation, no charge.
// A bare request (no address) still gets the 402 challenge, so x402 discovery crawlers can index the route.
// (The handler above re-checks it too; that check alone runs only after the payment was verified.)
const refuse = (req: NextRequest): Response | null => {
  const supplied = (req.nextUrl.searchParams.get("address") ?? "").trim();
  if (supplied && !isValidXrplAddress(supplied)) {
    return NextResponse.json(
      { error: "bad_request", message: "Provide a valid XRPL address (?address=r...) — an r-address whose checksum verifies. Nothing was screened, priced or charged." },
      { status: 400 }
    );
  }
  return null;
};

// Payable on BOTH rails at the same price: USDC on Base (X-PAYMENT, CDP) or RLUSD on XRPL (PAYMENT-SIGNATURE, t54).
// The XRPL rail runs this same handler; see src/lib/x402Dual.ts.
export const GET = dualX402({
  resource: "/api/x402/screen/ofac",
  plan: "x402:screen-ofac",
  amountRlusd: PRICE_PER_SCREEN_RLUSD,
  amountUsdc: PRICE_PER_SCREEN_USDC,
  name: "OFAC SDN screening attestation",
  description: SCREEN_OFAC_DESCRIPTION,
  schemas: {
    input: { type: "object", properties: { address: SCREEN_OFAC_INPUT_SCHEMA.properties.address }, required: ["address"] },
    output: SCREEN_OFAC_OUTPUT_SCHEMA,
    outputExample: SCREEN_OFAC_OUTPUT_EXAMPLE,
  },
  base: paidGET,
  core: handler,
  refuse,
});

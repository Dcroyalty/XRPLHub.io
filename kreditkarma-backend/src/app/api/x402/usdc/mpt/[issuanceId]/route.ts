// src/app/api/x402/usdc/mpt/[issuanceId]/route.ts
// The FULL MPT issuance risk view, paid: $0.01 in USDC on Base via x402.
// The free /api/mpt/:issuanceId gives issuance facts + issuer powers +
// issuer score/grade. This adds the parts that cost real live work —
// account age, blackhole check, xrp-ledger.toml domain verification, the
// full credential list, and the Bithomp cross-check — plus the `related`
// cross-sell block.
//
// Same withX402 v1 wrapper as /api/x402/usdc/score: settles only after a
// successful response. See src/lib/x402Base.ts for the pinning rationale.
import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "x402-next";
import { BASE_PAY_TO, BASE_NETWORK, PRICE_PER_MPT_USDC, cdpFacilitator } from "@/lib/x402Base";
import { getMptRisk, MPT_ISSUANCE_ID_RE } from "@/lib/mpt";
import { dualX402 } from "@/lib/x402Dual";
import { PRICE_PER_MPT_RLUSD } from "@/lib/paycall";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MPT_RISK_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    issuanceId: { type: "string" },
    found: { type: "boolean" },
    tier: { type: "string", enum: ["full"] },
    source: {
      type: "object",
      properties: {
        ledger: { type: "string" },
        bithompIndex: { type: "string" },
        interpretation: { type: "string", description: "'exists', 'may have been destroyed', or 'unknown' — never asserts non-existence." },
      },
    },
    issuer: { type: "string" },
    issuance: {
      type: "object",
      properties: {
        assetScale: { type: "integer" },
        maximumAmount: { type: "string" },
        outstandingAmount: { type: "string" },
        transferFeeBps: { type: "number" },
        metadata: { description: "Decoded MPTokenMetadata (JSON per XLS-89 where valid)." },
      },
    },
    issuerPowers: {
      type: "object",
      properties: {
        clawback: { type: "boolean", description: "Issuer can seize holder balances." },
        canFreeze: { type: "boolean" },
        currentlyFrozen: { type: "boolean" },
        requiresAuth: { type: "boolean", description: "Issuer must approve each holder." },
        transferable: { type: "boolean", description: "false = can only be returned to the issuer (store credit)." },
      },
    },
    issuerRisk: {
      type: "object",
      properties: {
        xrplScore: { type: "integer" },
        grade: { type: "string" },
        accountAgeDays: { type: "integer" },
        blackholed: { type: "boolean" },
        domain: { type: "string" },
        domainVerified: { type: "boolean", description: "Issuer address is listed in the domain's xrp-ledger.toml." },
        credentialsHeld: { type: "integer" },
        credentials: { type: "array", items: { type: "object" } },
      },
    },
    related: { type: "array", items: { type: "object", properties: { question: { type: "string" }, url: { type: "string" }, price: { type: "string" } } } },
  },
  required: ["issuanceId", "found", "source", "tier"],
} as const;

const handler = async (req: NextRequest): Promise<NextResponse<unknown>> => {
  const issuanceId = req.nextUrl.pathname.split("/").pop() ?? "";
  if (!MPT_ISSUANCE_ID_RE.test(issuanceId)) {
    return NextResponse.json(
      { error: "bad_request", message: "issuanceId must be 48 hexadecimal characters (the XLS-33 MPTokenIssuanceID)." },
      { status: 400 }
    );
  }
  try {
    return NextResponse.json(await getMptRisk(issuanceId, { full: true }));
  } catch (err) {
    return NextResponse.json(
      { error: "lookup_failed", message: err instanceof Error ? err.message : "unknown" },
      { status: 502 }
    );
  }
};

const MPT_DESCRIPTION =
  "Full risk view of one XLS-33 Multi-Purpose Token issuance: what the issuer can do to a holder " +
  "(clawback, freeze, require-auth, non-transferable) plus the issuer's XRPLScore, account age, " +
  "xrp-ledger.toml-verified domain, and credentials held. Live reads, cross-checked against " +
  "Bithomp. An issuance not found returns 'unknown', never 'does not exist'. Path: the 48-hex " +
  "MPTokenIssuanceID. The free /api/mpt/{id} gives issuance facts + powers + issuer score only.";

const paidGET = withX402(
  handler,
  BASE_PAY_TO,
  {
    price: `$${PRICE_PER_MPT_USDC}`,
    network: BASE_NETWORK,
    config: {
      description: MPT_DESCRIPTION,
      mimeType: "application/json",
      discoverable: true,
      outputSchema: MPT_RISK_OUTPUT_SCHEMA,
    },
  },
  cdpFacilitator
);

// Payable on BOTH rails at the same price: USDC on Base (X-PAYMENT, CDP) or RLUSD on XRPL (PAYMENT-SIGNATURE, t54).
// The path keeps its historical "usdc" segment so existing Base clients and listings keep working. No pre-challenge
// refusal here on purpose: a discovery crawler probes the literal {mptokenIssuanceID} template and must still get the 402.
export const GET = dualX402({
  resource: "/api/x402/usdc/mpt/{mptokenIssuanceID}",
  plan: "x402:mpt-risk",
  amountRlusd: PRICE_PER_MPT_RLUSD,
  amountUsdc: PRICE_PER_MPT_USDC,
  name: "MPT issuer risk (full)",
  description: MPT_DESCRIPTION,
  schemas: {
    input: {
      type: "object",
      properties: {
        mptokenIssuanceID: {
          type: "string",
          pattern: "^[0-9A-Fa-f]{48}$",
          description: "The MPTokenIssuanceID — 48 hex chars (XLS-33 192-bit id). Passed as the last URL path segment.",
        },
      },
      required: ["mptokenIssuanceID"],
    },
    output: MPT_RISK_OUTPUT_SCHEMA,
  },
  base: paidGET,
  core: handler,
});

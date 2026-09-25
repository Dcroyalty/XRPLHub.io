// src/app/api/x402-tx/route.ts
// RETIRED. The destination-tag payment scheme is replaced by the spec-compliant
// x402 v2 route /api/x402/tx (same product, priced at the storefront price of the requested service, proper
// accepts[] challenge with embedded input/output schema, settle-after-handler,
// idempotency). Three payment schemes were two too many.
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = {
  error: "retired",
  message:
    "This endpoint used a non-standard destination-tag payment scheme and is retired. " +
    "Use /api/x402/tx — spec-compliant x402 (RLUSD on XRPL or USDC on Base), same product, storefront price.",
  useInstead: "https://www.xrplhub.io/api/x402/tx",
  discovery: "https://www.xrplhub.io/.well-known/x402",
  price: "the storefront price of the requested service (USD = RLUSD = USDC); see /api/pricing",
};

export function GET() {
  return NextResponse.json(body, { status: 410, headers: { "Cache-Control": "no-store" } });
}
export function POST() {
  return NextResponse.json(body, { status: 410, headers: { "Cache-Control": "no-store" } });
}

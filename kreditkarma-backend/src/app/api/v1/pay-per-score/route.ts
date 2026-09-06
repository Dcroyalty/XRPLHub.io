// src/app/api/v1/pay-per-score/route.ts
// RETIRED. Replaced by /api/x402/score — spec-compliant x402 v2, same product,
// same $0.02 RLUSD price, proper accepts[] challenge with embedded schema,
// settle-after-handler, idempotency.
import { NextResponse } from "next/server";
import { PRICE_PER_SCORE_RLUSD } from "@/lib/paycall";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = {
  error: "retired",
  message:
    "This endpoint used a non-standard destination-tag payment scheme and is retired. " +
    "Use /api/x402/score — spec-compliant x402 v2, same product, same price.",
  useInstead: "https://www.xrplhub.io/api/x402/score",
  discovery: "https://www.xrplhub.io/.well-known/x402",
  price: `${PRICE_PER_SCORE_RLUSD} RLUSD`,
};

export function GET() {
  return NextResponse.json(body, { status: 410, headers: { "Cache-Control": "no-store" } });
}
export function POST() {
  return NextResponse.json(body, { status: 410, headers: { "Cache-Control": "no-store" } });
}

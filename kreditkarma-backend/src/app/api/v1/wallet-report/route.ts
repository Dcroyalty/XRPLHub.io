// src/app/api/v1/wallet-report/route.ts
// RETIRED. Replaced by /api/x402/report — spec-compliant x402 v2, same product,
// same $0.08 RLUSD price, proper accepts[] challenge with embedded schema,
// settle-after-handler, idempotency.
import { NextResponse } from "next/server";
import { PRICE_PER_PRODUCT_RLUSD } from "@/lib/paycall";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = {
  error: "retired",
  message:
    "This endpoint used a non-standard destination-tag payment scheme and is retired. " +
    "Use /api/x402/report — spec-compliant x402 v2, same product, same price.",
  useInstead: "https://www.xrplhub.io/api/x402/report",
  discovery: "https://www.xrplhub.io/.well-known/x402",
  price: `${PRICE_PER_PRODUCT_RLUSD} RLUSD`,
};

export function GET() {
  return NextResponse.json(body, { status: 410, headers: { "Cache-Control": "no-store" } });
}
export function POST() {
  return NextResponse.json(body, { status: 410, headers: { "Cache-Control": "no-store" } });
}

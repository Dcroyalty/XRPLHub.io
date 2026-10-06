// src/app/api/x402-tx/route.ts
// RETIRED. Transactions are free since 2026-10-05: use GET /api/tx (no payment).
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = {
  error: "retired",
  message:
    "This endpoint is retired. Transactions are free: use GET /api/tx?productId=<id>&account=r... — no payment.",
  useInstead: "https://www.xrplhub.io/api/tx",
  price: "free",
};

export function GET() {
  return NextResponse.json(body, { status: 410, headers: { "Cache-Control": "no-store" } });
}
export function POST() {
  return NextResponse.json(body, { status: 410, headers: { "Cache-Control": "no-store" } });
}

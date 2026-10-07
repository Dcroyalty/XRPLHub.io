// src/app/api/x402-tx/route.ts
// RETIRED 2026-10-07 — the generic transaction catalog was removed. See src/lib/retiredTx.ts.
import { retiredTxResponse } from "@/lib/retiredTx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() { return retiredTxResponse(); }
export function POST() { return retiredTxResponse(); }

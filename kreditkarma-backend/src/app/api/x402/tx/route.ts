// src/app/api/x402/tx/route.ts
// FREE since 2026-10-05 — the historical URL of the transaction endpoint. It no longer asks for an x402 payment: it serves
// the same free handler as /api/tx (the 31 transaction services are free on every path). Kept so existing clients and
// listings keep working. See src/lib/freeTxHttp.ts.
import { handleFreeTxRequest } from "@/lib/freeTxHttp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handleFreeTxRequest;
export const POST = handleFreeTxRequest;

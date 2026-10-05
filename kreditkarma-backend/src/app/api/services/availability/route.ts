// src/app/api/services/availability/route.ts
// GET /api/services/availability — which storefront services are buyable RIGHT NOW. A service that needs an amendment
// (src/lib/serviceAmendments.ts) is unavailable until the validated ledger says it is active; everything else is always
// available. One ledger read answers every service. The storefront disables Buy from this; the server enforces it anyway.

import { NextResponse } from "next/server";
import { BUILDABLE_SERVICE_IDS } from "@/app/api/execute/serviceCatalog";
import { servicesAvailability } from "@/lib/serviceAmendments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const all = await servicesAvailability(BUILDABLE_SERVICE_IDS);
  const gated = Object.values(all).filter((a) => a.amendment);
  return NextResponse.json(
    { checkedAt: new Date().toISOString(), unavailable: Object.values(all).filter((a) => !a.available).map((a) => a.productId), gated },
    { headers: { "Cache-Control": "public, max-age=30" } }
  );
}

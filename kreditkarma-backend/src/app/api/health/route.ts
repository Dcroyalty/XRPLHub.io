// src/app/api/health/route.ts
// GET /api/health — is the money path working? Reports DB, Xaman, both x402
// facilitators (t54 + CDP), the anchor config, the credential signing secret,
// alerting, and cron auth. Public (no secrets in the output), so an uptime
// monitor can watch it. The daily cron (index-mpts) runs the same probe and
// fires notifyError on anything red.
//
// 200 when overall is ok/warn, 503 when overall is down — so a monitor pages
// on "down" without parsing the body.
import { NextResponse } from "next/server";
import { healthProbe } from "@/lib/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

export async function GET(req: Request) {
  const deep = new URL(req.url).searchParams.get("deep") === "1";
  const report = await healthProbe({ deep });
  return NextResponse.json(report, {
    status: report.overall === "down" ? 503 : 200,
    headers: { "Cache-Control": "no-store" },
  });
}

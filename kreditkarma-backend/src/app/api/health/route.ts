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
import { isAdmin, adminUnauthorized } from "@/lib/adminAuth";
import { notifyError, alertingArmed } from "@/lib/notify";

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

// POST /api/health (admin only) — fire ONE test alert through the exact same
// notifyError path the payment rails use, so you can confirm ERROR_WEBHOOK_URL
// actually delivers. Does nothing else.
export async function POST(req: Request) {
  if (!isAdmin(req)) return adminUnauthorized();
  const armed = alertingArmed();
  await notifyError("POST /api/health (test alert)", new Error("Test alert — alerting is wired correctly. Ignore."), {
    at: new Date().toISOString(),
    note: "Manual test via POST /api/health",
  });
  return NextResponse.json({
    ok: true,
    alertingArmed: armed,
    delivered: armed
      ? "A test alert was POSTed to ERROR_WEBHOOK_URL. Check the channel."
      : "ERROR_WEBHOOK_URL is not set — the test was logged to Vercel only, nothing was sent.",
  });
}

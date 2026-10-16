// src/app/api/cron/grants-sync/route.ts — hourly: read new grants-pool payments from the XRP Ledger into the public
// ledger (src/lib/grantsPool.ts), send the once-a-year $20,000 donations alert if due, and one alert per card
// donation left unmoved to the pool for 30 days. Public and idempotent
// (it only reads public data), called by .github/workflows/lending-tracker.yml like the other hourly jobs.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { syncPoolLedger, maybeDonationsAlert, maybeCardUnmovedAlert } from "@/lib/grantsPool";
import { notifyError } from "@/lib/notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    const sync = await syncPoolLedger(prisma, Date.now() + 40_000);
    const alerted = await maybeDonationsAlert(prisma).catch(() => false);
    const unmovedAlerts = await maybeCardUnmovedAlert(prisma).catch(() => 0);
    return NextResponse.json({ ok: true, ...sync, donationsAlertSent: alerted, cardUnmovedAlerts: unmovedAlerts }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    await notifyError("cron grants-sync", e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

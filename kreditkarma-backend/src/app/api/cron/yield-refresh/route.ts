// src/app/api/cron/yield-refresh/route.ts — the hourly XRP Yield Desk refresh (src/lib/yieldDesk.ts).
//
// Triggered every hour by .github/workflows/lending-tracker.yml (Vercel Hobby crons can only run daily).
// PUBLIC on purpose, like the lending tracker: it only reads public data, and it does nothing if the last full
// refresh was under 45 minutes ago. (The first runs also catch up on 7 days of XRPL AMM trades, a little each run.)
// The daily watchdog refreshes it itself if the data is over 3 hours old, and goes RED only if that fails too.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { runYieldRefresh, lastRefresh } from "@/lib/yieldDesk";
import { recordHeartbeat } from "@/lib/watchdog";
import { notifyError } from "@/lib/notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // Vercel Hobby ceiling

export async function GET() {
  try {
    const last = await lastRefresh(prisma);
    if (last && Date.now() - last.getTime() < 45 * 60_000) {
      return NextResponse.json({ ok: true, skipped: "refreshed under 45 minutes ago", lastRefresh: last.toISOString() }, { headers: { "Cache-Control": "no-store" } });
    }
    const rep = await runYieldRefresh(prisma, { budgetMs: 45_000 });
    if (rep.ok) await recordHeartbeat(prisma, "yield-refresh", `${rep.options} options`);
    return NextResponse.json(rep, { status: rep.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    await notifyError("cron yield-refresh", e);
    return NextResponse.json({ ok: false, error: "refresh_failed" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}

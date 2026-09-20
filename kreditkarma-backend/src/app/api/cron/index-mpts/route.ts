// src/app/api/cron/index-mpts/route.ts
// Scheduled refresh of the MPTokenIssuance registry (src/lib/mptIndexer.ts).
// One call = one bounded chunk: a slice of the Bithomp per-issuer refresh
// (round-robined, stalest first) plus however far the ledger_data walk gets
// in the remaining budget. Registered in vercel.json under `crons`.
//
// Auth: Vercel's cron dispatcher sends `Authorization: Bearer $CRON_SECRET`
// automatically once CRON_SECRET is set. No secret set => this route 401s and
// does nothing (fails closed). The admin token also works for a manual kick.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { runMptIndexerPass, maybeAnchor } from "@/lib/mptIndexer";
import { isAdmin } from "@/lib/adminAuth";
import { healthProbe } from "@/lib/health";
import { notifyError, pingHealthcheck } from "@/lib/notify";
import { recordHeartbeat, runWatchdog } from "@/lib/watchdog";
import { forceFlushXrplCounters } from "@/lib/xrplCounters";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // Vercel Hobby ceiling

function isCronRequest(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed
  return (req.headers.get("authorization") ?? "") === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!isAdmin(req) && !isCronRequest(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    // Leave headroom under the 60s ceiling for the anchor + health steps
    // (connect + autofill + submitAndWait ~= 8-12s when an anchor is due).
    // (32s -> 24s: the watchdog below needs a few seconds; the indexer is resumable, so nothing is lost.)
    const progress = await runMptIndexerPass(prisma, { budgetMs: 24_000 });
    const anchor = await maybeAnchor(prisma);

    // Daily "is the money path working" sweep — alert on anything red.
    const health = await healthProbe({ deep: true });
    if (health.reds.length) {
      await notifyError(
        "cron/index-mpts healthcheck",
        new Error(`${health.reds.length} component(s) DOWN: ${health.reds.map((r) => r.name).join(", ")}`),
        Object.fromEntries(health.reds.map((r) => [r.name, r.detail]))
      );
    }

    forceFlushXrplCounters(prisma); // catch-all: land any counters this pass accrued

    // Unattended-operation watchdog: expiries (domains, TLS, XNS names, credentials), running-out (DB size, anchor
    // wallet), stopped jobs (OFAC refresh, anchors, monitoring), revoked keys — plus the other cron's heartbeat and
    // a weekly "still alive" message. See docs/AUTONOMY.md.
    await recordHeartbeat(prisma, "cron-mpts");
    const watchdog = await runWatchdog(prisma, { otherCrons: ["cron-credentials"], full: true, sendWeekly: true }).catch(async (e) => {
      await notifyError("cron/index-mpts watchdog", e);
      return null;
    });
    await pingHealthcheck();

    return NextResponse.json({ ...progress, anchor, health: { overall: health.overall, reds: health.reds, ambers: health.ambers }, watchdog: watchdog ? { alerted: watchdog.alerted, recovered: watchdog.recovered, weeklySent: watchdog.weeklySent, open: watchdog.findings.filter((f) => f.level !== "ok").map((f) => f.key) } : null });
  } catch (err) {
    await notifyError("cron/index-mpts", err);
    console.error("[cron/index-mpts]", err);
    return NextResponse.json(
      { error: "indexer_failed", message: err instanceof Error ? err.message : "unknown" },
      { status: 500 }
    );
  }
}

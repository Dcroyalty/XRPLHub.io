// src/app/api/cron/lending-tracker/route.ts — the hourly XRPL Lending job.
//
// Triggered every hour by .github/workflows/lending-tracker.yml (Vercel Hobby crons can only run daily).
// PUBLIC on purpose: it only reads public data, and it stores at most one snapshot per hour — a second call in
// the same hour returns the stored snapshot without touching XRPScan or the ledger (src/lib/lendingTracker.ts).
// So there is no secret to keep in GitHub, and a stray call can't do anything but refresh the page early.
//
// Health: every stored snapshot writes the `lending-tracker` heartbeat; the daily watchdog turns a snapshot
// older than 3 hours into a RED finding, which pings HEALTHCHECK_PING_URL/fail (healthchecks.io emails the
// owner). If LENDING_HEALTHCHECK_PING_URL is set (an hourly healthchecks.io check), each run also pings it.
//
// Phase 2: once LendingProtocol and SingleAssetVault are enabled on mainnet, the same run refreshes the
// vault/broker/loan index and the risk grades (src/lib/lendingIndex.ts). Until then that step is skipped.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { runTracker, lendingLive } from "@/lib/lendingTracker";
import { recordHeartbeat } from "@/lib/watchdog";
import { notifyError } from "@/lib/notify";
import { runLendingIndex } from "@/lib/lendingIndex";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // Vercel Hobby ceiling

async function pingHourly(fail: boolean, body: string): Promise<void> {
  const url = process.env.LENDING_HEALTHCHECK_PING_URL;
  if (!url || !/^https:\/\//.test(url)) return;
  try {
    await fetch(url.replace(/\/$/, "") + (fail ? "/fail" : ""), { method: "POST", body: body.slice(0, 10_000), signal: AbortSignal.timeout(5000) });
  } catch {
    /* never break the job */
  }
}

export async function GET() {
  const started = Date.now();
  try {
    const t = await runTracker(prisma);
    if (t.fresh && t.stored) await recordHeartbeat(prisma, "lending-tracker", t.snapshot.source);

    let index: unknown = { skipped: "lending is not enabled on mainnet yet" };
    if (await lendingLive()) {
      index = await runLendingIndex(prisma, { network: "mainnet", budgetMs: 40_000 }).catch(async (e) => {
        await notifyError("cron lending-tracker: index", e);
        return { error: e instanceof Error ? e.message : String(e) };
      });
    }

    const body = {
      ok: t.stored,
      fresh: t.fresh,
      hourBucket: t.snapshot.hourBucket,
      source: t.snapshot.source,
      amendments: t.snapshot.amendments.map((a) => ({ name: a.name, state: a.state, yes: a.yes, needed: a.needed })),
      index,
      ms: Date.now() - started,
    };
    if (t.fresh) await pingHourly(!t.stored, JSON.stringify(body));
    return NextResponse.json(body, { status: t.stored ? 200 : 503, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    await notifyError("cron lending-tracker", e);
    await pingHourly(true, `lending-tracker crashed: ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json({ ok: false, error: "tracker_failed" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}

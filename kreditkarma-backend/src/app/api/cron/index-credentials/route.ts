// src/app/api/cron/index-credentials/route.ts
// Scheduled trigger for the Credential census (src/lib/credentialIndexer.ts).
// One call = one bounded chunk of a walk, not a full pass — see that file for
// why. Registered in vercel.json under `crons`; Vercel Hobby only allows a
// once-daily schedule and each invocation is capped by maxDuration below, so
// getting to the FIRST complete pass quickly means hand-running
// scripts/census-credentials.cjs rather than waiting on the daily cron.
//
// Auth: Vercel's own cron dispatcher sends `Authorization: Bearer $CRON_SECRET`
// automatically once CRON_SECRET is set in the project's env — set it in
// Vercel or this route 401s and does nothing. The admin token also works, for
// manually kicking a pass forward without waiting on the schedule.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { runIndexerPass } from "@/lib/credentialIndexer";
import { isAdmin } from "@/lib/adminAuth";
import { notifyError, pingHealthcheck } from "@/lib/notify";
import { runMonitorPass } from "@/lib/monitorEngine";
import { maybeAnchorMonitorObservations } from "@/lib/monitorAnchor";
import { recordHeartbeat, runWatchdog, pingHealthcheckForRun } from "@/lib/watchdog";
import { refreshAllLists } from "@/lib/sanctionLists";
import { maybeAnchorScreeningReceipts } from "@/lib/screenAnchor";
import { maybeAnchorLendingReceipts } from "@/lib/lendingAnchor";
import { maybeAnchorUnderwriteReceipts } from "@/lib/underwriteAnchor";
import { runLendingSweep } from "@/lib/lendingSweep";
import { forceFlushXrplCounters } from "@/lib/xrplCounters";
import { runScreeningBackup } from "@/lib/screenBackup";
import { sweepPurchaseIntents } from "@/lib/purchaseIntent";
import { runAutoIssuance } from "@/lib/credentialAutoIssue";
import { runExpiredCredentialCleanup } from "@/lib/credentialCleanup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // Vercel Hobby ceiling

function isCronRequest(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed — no secret configured means no cron auth path
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!isAdmin(req) && !isCronRequest(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const t0 = Date.now();
  try {
    // Order matters. Credential census first (bounded, resumable, least urgent),
    // then SDN refresh, then the daily lending sweep, then the anchors LAST so
    // the sweep's fresh snapshots are anchored the same day. Every step is
    // budget/deadline-aware so both anchors still fit under the 60s ceiling.
    //
    // The census step is OFF unless CREDENTIAL_CENSUS_ENABLED=true. At 12s/day and 200 objects a
    // page it had covered ~1.7% of the keyspace in 15 days; the ledger holds ~20M objects, so it
    // could never finish. The SDN refresh, sweep and anchors below still run daily.
    const progress =
      process.env.CREDENTIAL_CENSUS_ENABLED === "true"
        ? await runIndexerPass(prisma, { budgetMs: 12_000 })
        : { census: "disabled" as const };

    // Automatic credential issuance -- a genuine no-op until CREDENTIAL_ISSUER_SEED is set (see
    // credentialAutoIssue.ts's header). Runs early, right after the census, while the cron's time
    // budget is freshest: real mainnet submitAndWait calls (up to MAX_PER_RUN of them) are the slowest
    // single thing this cron does.
    const autoIssuance = await runAutoIssuance(prisma, { deadlineMs: t0 + 30_000 }).catch((e) => {
      void notifyError("cron/index-credentials auto-issuance", e);
      return { ran: false, reason: "auto-issuance threw", issuedToday: 0, cap: 0, processed: [] };
    });

    // Same dormant-until-the-seed-is-set posture as auto-issuance above. Recycles reserve from expired,
    // never-accepted credentials -- separate from deleteExpiredCredentialIfAny (which only fires
    // opportunistically when REISSUING to the same subject; most expired-unaccepted credentials never
    // get reissued at all and would sit locked forever without this sweep).
    const credentialCleanup = await runExpiredCredentialCleanup({ deadlineMs: t0 + 35_000 }).catch((e) => {
      void notifyError("cron/index-credentials credential-cleanup", e);
      return { ran: false, reason: "cleanup threw", totalHeld: 0, qualifying: 0, deleted: 0, failed: 0 };
    });

    // Every sanctions list (OFAC-SDN, EU-FSF, UK-SL). Each list is independent: one failing or gated list never blocks the others,
    // and each alerts on its own fetch/parse/integrity failures. This catches anything ELSE that throws (database, unexpected).
    const sdn = await refreshAllLists(prisma, { deadlineMs: t0 + 22_000 }).catch(async (e) => {
      await notifyError("cron/index-credentials sanctions-refresh", e);
      return [{ action: "blocked-error" as const, listName: "ALL", detail: e instanceof Error ? e.message : "refresh threw" }];
    });

    // Continuous monitoring: after the SDN refresh (so a new list is visible to sanctions checks), before the
    // sweep and the anchors. Bounded by a deadline; anything not reached stays due and goes first next run.
    const monitor = await runMonitorPass(prisma, { deadlineMs: t0 + 30_000, deliverUntilMs: t0 + 37_000 }).catch(async (e) => {
      await notifyError("cron/index-credentials monitor", e);
      return { ran: false as const, reason: "monitor pass threw" };
    });

    // Re-observe every known borrower so the attested history has no gaps.
    const lendingSweep = await runLendingSweep(prisma, { deadlineMs: t0 + 42_000 }).catch((e) => {
      void notifyError("cron/index-credentials lending-sweep", e);
      return { ran: false, reason: "sweep threw", pass: 0, processed: 0, failed: 0, worklistTotal: 0, remainingThisPass: 0, passCompleted: false, lastCompletedPassAt: null, errors: [] };
    });

    const screeningAnchor = await maybeAnchorScreeningReceipts(prisma).catch((e) => {
      void notifyError("cron/index-credentials screening-anchor", e);
      return { attempted: false, submitted: false, reason: "anchor threw", leafCount: 0 };
    });

    const lendingAnchor = await maybeAnchorLendingReceipts(prisma).catch((e) => {
      void notifyError("cron/index-credentials lending-anchor", e);
      return { attempted: false, submitted: false, reason: "anchor threw", leafCount: 0 };
    });

    const underwriteAnchor = await maybeAnchorUnderwriteReceipts(prisma).catch((e) => {
      void notifyError("cron/index-credentials underwrite-anchor", e);
      return { attempted: false, submitted: false, reason: "anchor threw", leafCount: 0 };
    });

    // Off-Neon durability for the 10-year screening-receipt retention promise (see docs/AUTONOMY.md). Skips cleanly
    // (never throws) if GITHUB_TOKEN is unset — a real gap, but a visible one, never a silent one.
    const screeningBackup = await runScreeningBackup(prisma, { deadlineMs: t0 + 47_000 }).catch((e) => {
      void notifyError("cron/index-credentials screening-backup", e);
      return { ran: false, reason: "backup threw", daysProcessed: [], daysFailed: [], receiptsBackedUp: 0 };
    });

    // Monitoring observations: anchored last, and only if there is time left — resumable (they stay unanchored).
    const monitorAnchor =
      Date.now() < t0 + 44_000
        ? await maybeAnchorMonitorObservations(prisma).catch(async (e) => {
            await notifyError("cron/index-credentials monitor-anchor", e);
            return { attempted: false, submitted: false, reason: "anchor threw", leafCount: 0 };
          })
        : { attempted: false, submitted: false, reason: "skipped: cron time budget", leafCount: 0 };

    // Storefront auto-detection: catches a manually-sent payment even if the customer closed the tab and
    // never came back. Client-side polling (the primary, fast path) already covers a returning tab; this
    // is the guarantee for the case where nothing ever comes back to ask.
    const purchaseIntents = await sweepPurchaseIntents(prisma, { deadlineMs: t0 + 50_000 }).catch((e) => {
      void notifyError("cron/index-credentials purchase-intents", e);
      return { checked: 0, matched: 0 };
    });

    forceFlushXrplCounters(prisma); // catch-all for any counters this pass accrued

    // Dead-man's switch pair: this cron records a heartbeat and checks the OTHER cron's. healthchecks.io is
    // the alert channel: /fail on any open RED (from either cron's checks), else success; missed pings
    // cover both crons dying at once.
    await recordHeartbeat(prisma, "cron-credentials");
    const watchdog = await runWatchdog(prisma, { otherCrons: ["cron-mpts"], full: false }).catch(async (e) => {
      await notifyError("cron/index-credentials watchdog", e);
      return null;
    });
    await pingHealthcheckForRun(prisma, "cron/index-credentials", watchdog);
    return NextResponse.json({ ...progress, autoIssuance, credentialCleanup, sdn, monitor, lendingSweep, screeningAnchor, lendingAnchor, underwriteAnchor, screeningBackup, purchaseIntents, monitorAnchor, watchdog: watchdog ? { alerted: watchdog.alerted, recovered: watchdog.recovered, open: watchdog.findings.filter((f) => f.level !== "ok").map((f) => ({ key: f.key, level: f.level, message: f.message })) } : null });
  } catch (err) {
    await notifyError("cron/index-credentials", err);
    await pingHealthcheck("/fail", `XRPLHub cron/index-credentials CRASHED: ${err instanceof Error ? err.message : String(err)}`);
    console.error("[cron/index-credentials]", err);
    return NextResponse.json(
      { error: "indexer_failed", message: err instanceof Error ? err.message : "unknown" },
      { status: 500 }
    );
  }
}

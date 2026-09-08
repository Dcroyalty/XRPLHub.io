// src/lib/lendingSweep.ts
// Phase 2: the daily borrower sweep. Re-observes EVERY borrower XRPLHub has ever
// seen, every day, so the attested lending history has no gaps where nobody
// happened to run a paid query. A sweep observation is byte-identical in the
// record to a paid one (runExposureQuery, requestedBy "sweep") and flows into
// the same daily Merkle anchor.
//
// Ordering (the whole point is catching what disappears):
//   1. borrowers with active / impaired loans first — their evidence is the most
//      likely to be deleted
//   2. then stalest-first (lastSweptAt asc, never-swept first)
//
// Budget-aware + resumable: a pass is tracked on IndexerCheckpoint id
// "lending-sweep". Each cron run processes borrowers whose lastSweptPass < the
// current pass number, within the deadline, then checkpoints. Nobody is skipped
// — unprocessed borrowers keep lastSweptPass < currentPass and resume next run.

import type { PrismaClient } from "@prisma/client";
import { runExposureQuery } from "./lendingExposure";
import { lendingProtocolActive } from "./lendingLedger";
import { notifyError } from "./notify";

const CHECKPOINT_ID = "lending-sweep";
const PER_BORROWER_SOFT_MS = 9_000; // stop starting new borrowers if less than this remains

export interface SweepResult {
  ran: boolean;
  reason?: string;
  pass: number;
  processed: number;
  failed: number;
  worklistTotal: number;
  remainingThisPass: number;
  passCompleted: boolean;
  lastCompletedPassAt: string | null;
  errors: Array<{ borrower: string; error: string }>;
}

/** Ensure every borrower in LendingLoanObservation has a sweep work-list row
 *  (backfill for borrowers first observed before Phase 2). */
async function backfillWorklist(prisma: PrismaClient): Promise<void> {
  const observed = await prisma.lendingLoanObservation.findMany({
    distinct: ["borrower"],
    select: { borrower: true, firstObservedAt: true, lastObservedAt: true, lastKnownStatus: true },
  });
  if (observed.length === 0) return;
  const existing = new Set(
    (await prisma.lendingBorrowerSweep.findMany({ select: { borrower: true } })).map((r) => r.borrower)
  );
  const missing = observed.filter((o) => !existing.has(o.borrower));
  if (missing.length === 0) return;
  await prisma.lendingBorrowerSweep.createMany({
    data: missing.map((o) => ({
      borrower: o.borrower,
      firstObservedAt: o.firstObservedAt,
      lastObservedAt: o.lastObservedAt,
      hasActiveOrImpaired: o.lastKnownStatus === "current" || o.lastKnownStatus === "overdue" || o.lastKnownStatus === "overdueGraceExpired" || o.lastKnownStatus === "impaired",
      lastKnownWorstStatus: o.lastKnownStatus,
    })),
    skipDuplicates: true,
  });
}

export async function runLendingSweep(
  prisma: PrismaClient,
  opts: { deadlineMs: number }
): Promise<SweepResult> {
  const startedAt = Date.now();
  const empty = (reason: string, pass = 0): SweepResult => ({
    ran: false, reason, pass, processed: 0, failed: 0, worklistTotal: 0,
    remainingThisPass: 0, passCompleted: false, lastCompletedPassAt: null, errors: [],
  });

  // 1. Amendment gate — clean no-op, no snapshots.
  if (!(await lendingProtocolActive())) {
    return empty("amendment-not-active");
  }

  // 2. Backfill the work-list from historical observations.
  await backfillWorklist(prisma);

  // 3. Determine / start the current pass.
  let cp = await prisma.indexerCheckpoint.findUnique({ where: { id: CHECKPOINT_ID } });
  if (!cp) cp = await prisma.indexerCheckpoint.create({ data: { id: CHECKPOINT_ID, status: "idle" } });

  let pass = cp.passNumber;
  if (cp.status === "idle") {
    pass = cp.passNumber + 1;
    cp = await prisma.indexerCheckpoint.update({
      where: { id: CHECKPOINT_ID },
      data: { status: "running", passNumber: pass, passStartedAt: new Date() },
    });
  }

  const worklistTotal = await prisma.lendingBorrowerSweep.count();

  // 4. Process borrowers not yet done this pass — priority first, then stalest.
  let processed = 0;
  let failed = 0;
  const errors: SweepResult["errors"] = [];

  for (let guard = 0; guard < 5_000; guard++) {
    if (Date.now() > opts.deadlineMs - PER_BORROWER_SOFT_MS) break;

    const next = await prisma.lendingBorrowerSweep.findFirst({
      where: { lastSweptPass: { lt: pass } },
      orderBy: [{ hasActiveOrImpaired: "desc" }, { lastSweptAt: "asc" }, { addedToSweepAt: "asc" }],
    });
    if (!next) break; // everyone done this pass

    try {
      const out = await runExposureQuery(prisma, next.borrower, "sweep");
      await prisma.lendingBorrowerSweep.update({
        where: { borrower: next.borrower },
        data: {
          lastSweptAt: new Date(),
          lastSweptLedger: out.ledgerIndex,
          lastSweptPass: pass,
          sweepCount: { increment: 1 },
        },
      });
      processed++;
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ borrower: next.borrower, error: msg });
      // Mark it attempted this pass so we don't spin on one bad borrower, but
      // record nothing else — it stays stale and is retried next pass.
      await prisma.lendingBorrowerSweep.update({
        where: { borrower: next.borrower },
        data: { lastSweptPass: pass },
      });
    }
  }

  // 5. Pass complete?
  const remainingThisPass = await prisma.lendingBorrowerSweep.count({ where: { lastSweptPass: { lt: pass } } });
  const passCompleted = remainingThisPass === 0;

  const cpUpdate = passCompleted
    ? { status: "idle", lastCompletedPassAt: new Date(), lastCompletedPassNumber: pass }
    : { status: "running" };
  const after = await prisma.indexerCheckpoint.update({ where: { id: CHECKPOINT_ID }, data: cpUpdate });

  if (failed > 0) {
    await notifyError(
      "cron lending-sweep",
      new Error(`${failed} borrower(s) failed to sweep this run`),
      { pass, processed, failed, sample: errors.slice(0, 3) }
    );
  }

  return {
    ran: true,
    pass,
    processed,
    failed,
    worklistTotal,
    remainingThisPass,
    passCompleted,
    lastCompletedPassAt: after.lastCompletedPassAt ? after.lastCompletedPassAt.toISOString() : null,
    errors: errors.slice(0, 10),
  };
}

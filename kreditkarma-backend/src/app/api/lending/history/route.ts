// src/app/api/lending/history/route.ts
// GET /api/lending/history?borrower=r...  — the credit file XLS-66 can't keep.
//
// Every loan XRPLHub has EVER observed for this borrower, built from the
// append-only LendingExposureSnapshot rows: first/last observed, last-known
// status, monotonic ever-defaulted / ever-impaired flags, and — for loans that
// have since vanished from the ledger — the window in which they disappeared.
// A borrower who defaulted and then deleted the loan shows nothing on-ledger;
// here it shows as vanished with everDefaulted = true.
//
// Free (API key, free tier). It is derived entirely from data we persisted for
// free on prior exposure queries.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { extractKey, resolveApiKey } from "@/lib/keys";
import { guard } from "@/lib/guard";
import { isValidXrplAddress, LENDING_DISCLAIMER, sweepCoverageFor } from "@/lib/lendingExposure";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function GET(req: Request) {
  const borrower = new URL(req.url).searchParams.get("borrower");

  const r = await resolveApiKey(extractKey(req));
  if (!r.ok) {
    return NextResponse.json(
      { error: r.reason === "expired" ? "key_expired" : "unauthorized", message: "Valid API key required (a free key works)." },
      { status: r.reason === "expired" ? 402 : 401 }
    );
  }
  if (!borrower || !isValidXrplAddress(borrower)) {
    return NextResponse.json({ error: "bad_request", message: "Provide a valid XRPL address: ?borrower=r..." }, { status: 400 });
  }

  const g = await guard(r.key.id, r.key.plan);
  if (!g.ok) {
    return NextResponse.json({ error: "rate_limited", message: g.reason }, { status: g.status });
  }

  const [obs, snapCount, firstSnap, lastSnap, sweepCoverage] = await Promise.all([
    prisma.lendingLoanObservation.findMany({ where: { borrower }, orderBy: { firstObservedAt: "asc" } }),
    prisma.lendingExposureSnapshot.count({ where: { borrower } }),
    prisma.lendingExposureSnapshot.findFirst({ where: { borrower }, orderBy: { observedAt: "asc" }, select: { observedAt: true, ledgerIndex: true } }),
    prisma.lendingExposureSnapshot.findFirst({ where: { borrower }, orderBy: { observedAt: "desc" }, select: { observedAt: true, ledgerIndex: true, queryId: true } }),
    sweepCoverageFor(prisma, borrower),
  ]);

  const vanished = obs.filter((o) => o.disappearedAt != null);
  const vanishedBad = vanished.filter((o) => o.everDefaulted || o.everImpaired);

  return NextResponse.json(
    {
      borrower,
      observationWindow: {
        firstObservedAt: firstSnap?.observedAt.toISOString() ?? null,
        firstObservedLedger: firstSnap?.ledgerIndex ?? null,
        lastObservedAt: lastSnap?.observedAt.toISOString() ?? null,
        lastObservedLedger: lastSnap?.ledgerIndex ?? null,
        lastQueryId: lastSnap?.queryId ?? null,
        totalSnapshots: snapCount,
        note:
          "XRPLHub cannot see loans created and deleted before firstObservedAt. Query /api/lending/exposure to add an observation now.",
      },
      sweepCoverage,
      summary: {
        loansEverObserved: obs.length,
        currentlyOnLedger: obs.length - vanished.length,
        vanished: vanished.length,
        vanishedEverDefaultedOrImpaired: vanishedBad.length,
        anyEverDefaulted: obs.some((o) => o.everDefaulted),
        anyEverImpaired: obs.some((o) => o.everImpaired),
      },
      loans: obs.map((o) => ({
        loanId: o.loanId,
        loanBrokerId: o.loanBrokerId,
        brokerOwner: o.brokerOwner,
        asset: o.asset,
        firstObservedAt: o.firstObservedAt.toISOString(),
        firstObservedLedger: o.firstObservedLedger,
        lastObservedAt: o.lastObservedAt.toISOString(),
        lastObservedLedger: o.lastObservedLedger,
        observationCount: o.observationCount,
        lastKnownStatus: o.lastKnownStatus,
        lastKnownPrincipal: o.lastKnownPrincipal,
        lastKnownTotalValue: o.lastKnownTotalValue,
        everOverdue: o.everOverdue,
        everImpaired: o.everImpaired,
        everDefaulted: o.everDefaulted,
        onLedgerNow: o.disappearedAt == null,
        disappearedAt: o.disappearedAt ? o.disappearedAt.toISOString() : null,
        disappearedBetweenLedgers:
          o.disappearedAt != null ? [o.disappearedAfterLedger, o.disappearedBeforeLedger] : null,
        reappearedAt: o.reappearedAt ? o.reappearedAt.toISOString() : null,
      })),
      disclaimer: LENDING_DISCLAIMER,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

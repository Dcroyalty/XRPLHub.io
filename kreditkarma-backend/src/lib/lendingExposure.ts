// src/lib/lendingExposure.ts
// XLS-66 cross-broker lending exposure — the credit file the ledger can't keep.
//
// XLS-66 stores CURRENT exposure only. A defaulted Loan zeroes its own amounts;
// either party may LoanDelete a paid/defaulted Loan to reclaim the borrower's
// reserve. So a borrower can erase the evidence of their own default. Every
// exposure query here persists ONE immutable LendingExposureSnapshot and updates
// a per-(borrower,loan) LendingLoanObservation tracker that only ever
// accumulates. A query is a free observation of state that may not exist
// tomorrow — so we record it every time, never just on a sweep.

import { randomUUID } from "crypto";
import type { PrismaClient } from "@prisma/client";
import { computeScore, isValidXrplAddress, AccountNotFoundError } from "./engine";
import {
  lendingProtocolActive,
  validatedLedger,
  fetchBorrowerLoans,
  fetchBroker,
  fetchVaultAsset,
  type RawLoan,
  type RawBroker,
  type ResolvedAsset,
} from "./lendingLedger";
import {
  LENDING_CANON_VERSION,
  LENDING_ENGINE_VERSION,
  lendingLeafHash,
  type LendingExposureLeaf,
  type ExposureAssetEntry,
} from "./lendingCanon";

export { isValidXrplAddress };

const RIPPLE_EPOCH_OFFSET = 946_684_800;
const LSF_LOAN_DEFAULT = 0x00010000;
const LSF_LOAN_IMPAIRED = 0x00020000;
const LSF_LOAN_OVERPAYMENT = 0x00040000;

export const LENDING_EXPOSURE_DESCRIPTION =
  "A borrower's total XLS-66 lending exposure across ALL loan brokers in one call: outstanding by asset, " +
  "loan count, broker count, impairments, defaults, plus XRPLHub's XRPLScore. The XRP Ledger has no " +
  "aggregate borrower-debt object; a broker sees only its own loans. Reflects the validated ledger NOW: " +
  "defaulted loans zero their own amounts and paid/defaulted loans get deleted, so absence is not proof " +
  "of no borrowing history. Not underwriting or credit advice.";

export const LENDING_DISCLAIMER =
  "This is on-chain lending exposure as the validated XRP Ledger shows it at the stated ledger index. " +
  "XLS-66 keeps CURRENT exposure only: a defaulted loan zeroes its own PrincipalOutstanding and " +
  "TotalValueOutstanding (the lsfLoanDefault flag is the credit event, not the balance), and either the " +
  "borrower or the broker may delete a paid or defaulted loan to reclaim the borrower's reserve. The " +
  "absence of loans is NOT proof that a borrower has never borrowed or defaulted. XRPLHub's own observation " +
  "history begins at first_observed_at for this borrower and cannot see loans created and deleted before " +
  "then. This is not lending, credit, underwriting, or compliance advice, and does not replace your own " +
  "underwriting. You remain responsible for every lending decision.";

// ── Status ───────────────────────────────────────────────────────────────────
export type LoanStatus =
  | "current"
  | "overdue"
  | "overdueGraceExpired"
  | "impaired"
  | "defaulted"
  | "paid";

const STATUS_SEVERITY: Record<LoanStatus, number> = {
  defaulted: 5,
  impaired: 4,
  overdueGraceExpired: 3,
  overdue: 2,
  current: 1,
  paid: 0,
};

export function deriveLoanStatus(loan: RawLoan, nowRippleSec: number): LoanStatus {
  if (loan.Flags & LSF_LOAN_DEFAULT) return "defaulted";
  if (loan.Flags & LSF_LOAN_IMPAIRED) return "impaired";
  if (loan.PaymentRemaining === 0) return "paid";
  if (loan.NextPaymentDueDate > 0 && nowRippleSec > loan.NextPaymentDueDate + loan.GracePeriod)
    return "overdueGraceExpired";
  if (loan.NextPaymentDueDate > 0 && nowRippleSec > loan.NextPaymentDueDate) return "overdue";
  return "current";
}

const rippleToIso = (s: number): string | null =>
  s > 0 ? new Date((s + RIPPLE_EPOCH_OFFSET) * 1000).toISOString() : null;

// ── Per-loan enriched view ───────────────────────────────────────────────────
export interface EnrichedLoan {
  loanId: string;
  loanBrokerId: string;
  broker: { owner: string | null; pseudoAccount: string | null; vaultId: string | null; asset: string };
  status: LoanStatus;
  principalOutstanding: string;
  totalValueOutstanding: string;
  managementFeeOutstanding: string | null;
  interestRateBps: number;
  lateInterestRateBps: number | null;
  startDate: string | null;
  nextPaymentDueDate: string | null;
  previousPaymentDueDate: string | null;
  paymentInterval: number;
  paymentRemaining: number;
  gracePeriod: number;
  periodicPayment: string | null;
  daysUntilDue: number | null;
  daysOverdue: number | null;
  flags: { default: boolean; impaired: boolean; overpayment: boolean };
}

export interface BrokerView {
  loanBrokerId: string;
  owner: string | null;
  pseudoAccount: string | null;
  vaultId: string | null;
  asset: string;
  loanCount: number;
  statusRollup: Record<string, number>;
  debtTotal: string | null;
  coverAvailable: string | null;
  coverRateMinimumBps: number | null;
}

export interface ExposureResult {
  queryId: string;
  borrower: string;
  amendmentActive: boolean;
  ledgerIndex: number;
  ledgerCloseAt: string | null;
  generatedAt: string;
  disposition: "amendment-not-active" | "active-exposure" | "history-only" | "no-loans-ever";
  exposure: {
    byAsset: Record<string, ExposureAssetEntry & { currency?: string; issuer?: string; mptIssuanceId?: string }>;
    loanCount: number;
    brokerCount: number;
  };
  events: { defaulted: number; impaired: number; overdue: number; overdueGraceExpired: number };
  worstStatus: string;
  earliestNextPaymentDue: string | null;
  xrplScore: number | null;
  grade: string | null;
  observation: {
    everObservedLoans: boolean;
    firstObservedAt: string | null;
    totalLoansEverObserved: number;
    currentlyVisible: number;
    vanished: number;
    vanishedLastSeenDefaultedOrImpaired: number;
    note: string;
  };
  loans: EnrichedLoan[]; // full detail — surfaced only on the paid route
  brokers: BrokerView[]; // full detail — surfaced only on the paid route
  vanishedLoans: Array<{
    loanId: string;
    loanBrokerId: string;
    lastKnownStatus: string;
    everDefaulted: boolean;
    everImpaired: boolean;
    firstObservedAt: string;
    lastObservedAt: string;
    disappearedAfterLedger: number | null;
    disappearedBeforeLedger: number | null;
  }>;
  leafHash: string;
  disclaimer: string;
}

// ── The observation snapshot ─────────────────────────────────────────────────

/**
 * Walk the borrower's loans, aggregate, PERSIST an immutable snapshot, update the
 * loan-observation tracker (detecting any loan that has vanished), and return the
 * full result. `requestedBy` is "key:<prefix>" | "x402:<id>" | "mcp" | "sweep".
 *
 * A "sweep" observation is byte-identical in the attested record to a paid one —
 * `requestedBy` is stored on the row but is NOT part of the canonical leaf.
 *
 * The XRPLScore is ALWAYS computed fresh here (computeScore -> scoreWallet). It
 * is anchored inside the canonical leaf, so a cached value would be a stale
 * number signed on-chain as current — the same class of bug as the degradation
 * failure. Never wire the display cache (src/lib/scoreCache.ts) into this path;
 * scripts/check-attestation-freshness.mjs fails the build if you do.
 */
export async function runExposureQuery(
  prisma: PrismaClient,
  borrower: string,
  requestedBy: string
): Promise<ExposureResult> {
  const queryId = randomUUID();
  const generatedAt = new Date().toISOString();

  // XRPLScore — always fresh (goes into the anchored leaf).
  let xrplScore: number | null = null;
  let grade: string | null = null;
  try {
    const s = await computeScore(borrower);
    xrplScore = s.score;
    grade = s.grade;
  } catch (e) {
    if (!(e instanceof AccountNotFoundError)) throw e;
  }

  const active = await lendingProtocolActive();
  const led = await validatedLedger();
  const nowRipple = led.closeAt ? Math.floor(led.closeAt.getTime() / 1000) - RIPPLE_EPOCH_OFFSET : Math.floor(Date.now() / 1000) - RIPPLE_EPOCH_OFFSET;

  const emptyEvents = { defaulted: 0, impaired: 0, overdue: 0, overdueGraceExpired: 0 };

  if (!active) {
    // No Loan objects can exist. Do NOT persist a snapshot (nothing to observe).
    const prior = await priorObservation(prisma, borrower);
    return {
      queryId,
      borrower,
      amendmentActive: false,
      ledgerIndex: led.index,
      ledgerCloseAt: led.closeAt ? led.closeAt.toISOString() : null,
      generatedAt,
      disposition: "amendment-not-active",
      exposure: { byAsset: {}, loanCount: 0, brokerCount: 0 },
      events: emptyEvents,
      worstStatus: "none",
      earliestNextPaymentDue: null,
      xrplScore,
      grade,
      observation: prior.summary,
      loans: [],
      brokers: [],
      vanishedLoans: prior.vanished,
      leafHash: "",
      disclaimer: LENDING_DISCLAIMER,
    };
  }

  // ── Amendment active: walk the ledger ──────────────────────────────────────
  const rawLoans = await fetchBorrowerLoans(borrower);

  // Resolve each distinct broker + its vault asset once.
  const brokerIds = [...new Set(rawLoans.map((l) => l.LoanBrokerID).filter(Boolean))];
  const brokerMap = new Map<string, RawBroker | null>();
  const assetMap = new Map<string, ResolvedAsset>();
  for (const bid of brokerIds) {
    const b = await fetchBroker(bid);
    brokerMap.set(bid, b);
    if (b?.VaultID) assetMap.set(bid, await fetchVaultAsset(b.VaultID));
    else assetMap.set(bid, { kind: "unknown", key: "unknown" });
  }

  const enriched: EnrichedLoan[] = rawLoans.map((l) => {
    const b = brokerMap.get(l.LoanBrokerID) ?? null;
    const asset = assetMap.get(l.LoanBrokerID) ?? { kind: "unknown", key: "unknown" };
    const status = deriveLoanStatus(l, nowRipple);
    const nextIso = rippleToIso(l.NextPaymentDueDate);
    const secToDue = l.NextPaymentDueDate > 0 ? l.NextPaymentDueDate - nowRipple : null;
    return {
      loanId: l.index,
      loanBrokerId: l.LoanBrokerID,
      broker: { owner: b?.Owner ?? null, pseudoAccount: b?.Account ?? null, vaultId: b?.VaultID ?? null, asset: asset.key },
      status,
      principalOutstanding: l.PrincipalOutstanding,
      totalValueOutstanding: l.TotalValueOutstanding,
      managementFeeOutstanding: l.ManagementFeeOutstanding ?? null,
      interestRateBps: l.InterestRate,
      lateInterestRateBps: l.LateInterestRate ?? null,
      startDate: rippleToIso(l.StartDate),
      nextPaymentDueDate: nextIso,
      previousPaymentDueDate: rippleToIso(l.PreviousPaymentDueDate ?? 0),
      paymentInterval: l.PaymentInterval,
      paymentRemaining: l.PaymentRemaining,
      gracePeriod: l.GracePeriod,
      periodicPayment: l.PeriodicPayment ?? null,
      daysUntilDue: secToDue != null && secToDue > 0 ? Math.round((secToDue / 86400) * 100) / 100 : null,
      daysOverdue: secToDue != null && secToDue < 0 ? Math.round((-secToDue / 86400) * 100) / 100 : null,
      flags: {
        default: !!(l.Flags & LSF_LOAN_DEFAULT),
        impaired: !!(l.Flags & LSF_LOAN_IMPAIRED),
        overpayment: !!(l.Flags & LSF_LOAN_OVERPAYMENT),
      },
    };
  });

  // Aggregate exposure by resolved asset.
  const byAsset: ExposureResult["exposure"]["byAsset"] = {};
  for (const l of enriched) {
    const key = l.broker.asset;
    const cur = byAsset[key] ?? { principalOutstanding: "0", totalValueOutstanding: "0", loanCount: 0 };
    cur.principalOutstanding = addDecimal(cur.principalOutstanding, l.principalOutstanding);
    cur.totalValueOutstanding = addDecimal(cur.totalValueOutstanding, l.totalValueOutstanding);
    cur.loanCount += 1;
    const a = assetMap.get(l.loanBrokerId);
    if (a?.kind === "IOU") {
      cur.currency = a.currency;
      cur.issuer = a.issuer;
      const disp = decodeCurrency(a.currency);
      if (disp) (cur as { currencyDisplay?: string }).currencyDisplay = disp;
    }
    if (a?.kind === "MPT") cur.mptIssuanceId = a.mptIssuanceId;
    byAsset[key] = cur;
  }

  const events = { ...emptyEvents };
  let worst: LoanStatus | "none" = "none";
  let earliestNextSec = 0;
  for (const l of enriched) {
    if (l.status === "defaulted") events.defaulted++;
    if (l.status === "impaired") events.impaired++;
    if (l.status === "overdue") events.overdue++;
    if (l.status === "overdueGraceExpired") events.overdueGraceExpired++;
    if (worst === "none" || STATUS_SEVERITY[l.status] > STATUS_SEVERITY[worst as LoanStatus]) worst = l.status;
    const dueSec = raw(l.nextPaymentDueDate);
    if (l.status !== "paid" && l.status !== "defaulted" && dueSec > 0 && (earliestNextSec === 0 || dueSec < earliestNextSec)) {
      earliestNextSec = dueSec;
    }
  }

  const brokers: BrokerView[] = brokerIds.map((bid) => {
    const b = brokerMap.get(bid) ?? null;
    const asset = assetMap.get(bid) ?? { kind: "unknown", key: "unknown" };
    const ls = enriched.filter((e) => e.loanBrokerId === bid);
    const rollup: Record<string, number> = {};
    for (const e of ls) rollup[e.status] = (rollup[e.status] ?? 0) + 1;
    return {
      loanBrokerId: bid,
      owner: b?.Owner ?? null,
      pseudoAccount: b?.Account ?? null,
      vaultId: b?.VaultID ?? null,
      asset: asset.key,
      loanCount: ls.length,
      statusRollup: rollup,
      debtTotal: b?.DebtTotal ?? null,
      coverAvailable: b?.CoverAvailable ?? null,
      coverRateMinimumBps: b?.CoverRateMinimum ?? null,
    };
  });

  const visibleLoanIds = enriched.map((e) => e.loanId).sort();

  // ── Build + hash the canonical leaf ───────────────────────────────────────
  const canonExposure: Record<string, ExposureAssetEntry> = {};
  for (const [k, v] of Object.entries(byAsset)) {
    canonExposure[k] = {
      principalOutstanding: v.principalOutstanding,
      totalValueOutstanding: v.totalValueOutstanding,
      loanCount: v.loanCount,
    };
  }
  const leaf: LendingExposureLeaf = {
    queryId,
    borrower,
    ledgerIndex: led.index,
    ledgerCloseAt: led.closeAt ? led.closeAt.toISOString() : null,
    amendmentActive: true,
    exposureByAsset: canonExposure,
    loanCount: enriched.length,
    brokerCount: brokerIds.length,
    events,
    worstStatus: worst,
    visibleLoanIds,
    xrplScore,
    engineVersion: LENDING_ENGINE_VERSION,
    generatedAt,
  };
  const leafHash = lendingLeafHash(leaf);

  // ── PERSIST the immutable snapshot ────────────────────────────────────────
  await prisma.lendingExposureSnapshot.create({
    data: {
      queryId,
      borrower,
      ledgerIndex: led.index,
      ledgerCloseAt: led.closeAt,
      amendmentActive: true,
      loanCount: enriched.length,
      brokerCount: brokerIds.length,
      worstStatus: worst,
      exposureByAsset: canonExposure as unknown as object,
      events: events as unknown as object,
      visibleLoanIds: visibleLoanIds as unknown as object,
      loans: enriched as unknown as object,
      earliestNextPaymentDueAt: earliestNextSec > 0 ? new Date((earliestNextSec + RIPPLE_EPOCH_OFFSET) * 1000) : null,
      xrplScore,
      grade,
      requestedBy,
      canonVersion: LENDING_CANON_VERSION,
      engineVersion: LENDING_ENGINE_VERSION,
      leafHash,
    },
  });

  // ── Update the loan-observation tracker (accumulate-only) ─────────────────
  const obsSummary = await updateObservations(prisma, borrower, led.index, enriched);

  // ── Keep the sweep work-list current (priority = has active/impaired loans) ─
  const hasActiveOrImpaired = enriched.some(
    (l) => l.status === "current" || l.status === "overdue" || l.status === "overdueGraceExpired" || l.status === "impaired"
  );
  const now = new Date();
  await prisma.lendingBorrowerSweep
    .upsert({
      where: { borrower },
      update: { lastObservedAt: now, hasActiveOrImpaired, lastKnownWorstStatus: worst },
      create: {
        borrower,
        firstObservedAt: now,
        lastObservedAt: now,
        hasActiveOrImpaired,
        lastKnownWorstStatus: worst,
      },
    })
    .catch(() => {});

  const disposition: ExposureResult["disposition"] =
    enriched.length > 0 ? "active-exposure" : obsSummary.everObservedLoans ? "history-only" : "no-loans-ever";

  return {
    queryId,
    borrower,
    amendmentActive: true,
    ledgerIndex: led.index,
    ledgerCloseAt: led.closeAt ? led.closeAt.toISOString() : null,
    generatedAt,
    disposition,
    exposure: { byAsset, loanCount: enriched.length, brokerCount: brokerIds.length },
    events,
    worstStatus: worst,
    earliestNextPaymentDue: earliestNextSec > 0 ? rippleToIso(earliestNextSec) : null,
    xrplScore,
    grade,
    observation: obsSummary.summary,
    loans: enriched,
    brokers,
    vanishedLoans: obsSummary.vanished,
    leafHash,
    disclaimer: LENDING_DISCLAIMER,
  };
}

// ── Sweep coverage / observation gaps ────────────────────────────────────────

// We sweep daily, so anything longer than this between two consecutive
// observations is a window in which a loan could have appeared and been deleted
// unseen. Honest reporting, not alarm — a gap doesn't mean something WAS missed.
const OBSERVATION_GAP_THRESHOLD_MS = 2.5 * 24 * 60 * 60 * 1000;

export interface SweepCoverage {
  inSweepWorklist: boolean;
  priority: "high" | "normal";
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  lastSweptAt: string | null;
  lastSweptLedger: number | null;
  sweepCount: number;
  currentPass: number | null;
  sweptThisPass: boolean;
  observationGaps: Array<{ fromLedger: number; toLedger: number; fromAt: string; toAt: string; days: number }>;
  trailingGapDays: number | null;
  note: string;
}

export async function sweepCoverageFor(prisma: PrismaClient, borrower: string): Promise<SweepCoverage> {
  const [row, checkpoint, snaps] = await Promise.all([
    prisma.lendingBorrowerSweep.findUnique({ where: { borrower } }),
    prisma.indexerCheckpoint.findUnique({ where: { id: "lending-sweep" } }),
    prisma.lendingExposureSnapshot.findMany({
      where: { borrower },
      orderBy: { observedAt: "asc" },
      select: { ledgerIndex: true, observedAt: true },
    }),
  ]);

  const gaps: SweepCoverage["observationGaps"] = [];
  for (let i = 1; i < snaps.length; i++) {
    const dt = snaps[i].observedAt.getTime() - snaps[i - 1].observedAt.getTime();
    if (dt > OBSERVATION_GAP_THRESHOLD_MS) {
      gaps.push({
        fromLedger: snaps[i - 1].ledgerIndex,
        toLedger: snaps[i].ledgerIndex,
        fromAt: snaps[i - 1].observedAt.toISOString(),
        toAt: snaps[i].observedAt.toISOString(),
        days: Math.round((dt / 86_400_000) * 10) / 10,
      });
    }
  }
  const lastSnap = snaps[snaps.length - 1];
  const trailingGapDays = lastSnap
    ? Math.round(((Date.now() - lastSnap.observedAt.getTime()) / 86_400_000) * 10) / 10
    : null;

  const currentPass = checkpoint?.passNumber ?? null;
  const sweptThisPass = !!row && currentPass != null && row.lastSweptPass === currentPass;

  let note: string;
  if (!row) {
    note = "This borrower is not yet in the daily sweep work-list (no loan observed since Phase 2 began). It is added the first time any loan is seen.";
  } else if (gaps.length === 0 && (trailingGapDays == null || trailingGapDays < 2.5)) {
    note = "No gaps: observations are continuous within the daily-sweep cadence since firstObservedAt.";
  } else {
    note =
      `${gaps.length} internal gap(s)` +
      (trailingGapDays != null && trailingGapDays >= 2.5 ? ` plus a ${trailingGapDays}-day trailing gap since the last observation` : "") +
      ". A loan could have appeared and been deleted inside a gap without XRPLHub seeing it. History before firstObservedAt is never visible to us.";
  }

  return {
    inSweepWorklist: !!row,
    priority: row?.hasActiveOrImpaired ? "high" : "normal",
    firstObservedAt: row ? row.firstObservedAt.toISOString() : (snaps[0]?.observedAt.toISOString() ?? null),
    lastObservedAt: row ? row.lastObservedAt.toISOString() : (lastSnap?.observedAt.toISOString() ?? null),
    lastSweptAt: row?.lastSweptAt ? row.lastSweptAt.toISOString() : null,
    lastSweptLedger: row?.lastSweptLedger ?? null,
    sweepCount: row?.sweepCount ?? 0,
    currentPass,
    sweptThisPass,
    observationGaps: gaps,
    trailingGapDays,
    note,
  };
}

// ── Observation tracker ──────────────────────────────────────────────────────

interface ObsBundle {
  everObservedLoans: boolean;
  vanished: ExposureResult["vanishedLoans"];
  summary: ExposureResult["observation"];
}

/** Read-only observation summary (used pre-activation and for /api/lending/history). */
export async function priorObservation(prisma: PrismaClient, borrower: string): Promise<ObsBundle> {
  const obs = await prisma.lendingLoanObservation.findMany({ where: { borrower }, orderBy: { firstObservedAt: "asc" } });
  return buildObsBundle(obs, null);
}

async function updateObservations(
  prisma: PrismaClient,
  borrower: string,
  ledgerIndex: number,
  visible: EnrichedLoan[]
): Promise<ObsBundle> {
  const now = new Date();
  const existing = await prisma.lendingLoanObservation.findMany({ where: { borrower } });
  const existingById = new Map(existing.map((o) => [o.loanId, o]));
  const visibleIds = new Set(visible.map((v) => v.loanId));

  for (const v of visible) {
    const prev = existingById.get(v.loanId);
    const isDefault = v.flags.default;
    const isImpaired = v.flags.impaired;
    const isOverdue = v.status === "overdue" || v.status === "overdueGraceExpired";
    if (!prev) {
      await prisma.lendingLoanObservation.create({
        data: {
          borrower,
          loanId: v.loanId,
          loanBrokerId: v.loanBrokerId,
          brokerOwner: v.broker.owner,
          asset: v.broker.asset,
          firstObservedAt: now,
          firstObservedLedger: ledgerIndex,
          lastObservedAt: now,
          lastObservedLedger: ledgerIndex,
          observationCount: 1,
          lastKnownStatus: v.status,
          lastKnownPrincipal: v.principalOutstanding,
          lastKnownTotalValue: v.totalValueOutstanding,
          everImpaired: isImpaired,
          everDefaulted: isDefault,
          everOverdue: isOverdue,
        },
      });
    } else {
      await prisma.lendingLoanObservation.update({
        where: { id: prev.id },
        data: {
          lastObservedAt: now,
          lastObservedLedger: ledgerIndex,
          observationCount: { increment: 1 },
          lastKnownStatus: v.status,
          lastKnownPrincipal: v.principalOutstanding,
          lastKnownTotalValue: v.totalValueOutstanding,
          brokerOwner: v.broker.owner ?? prev.brokerOwner,
          asset: v.broker.asset ?? prev.asset,
          everImpaired: prev.everImpaired || isImpaired,
          everDefaulted: prev.everDefaulted || isDefault,
          everOverdue: prev.everOverdue || isOverdue,
          // A loan that had vanished is back — record it, don't hide it.
          ...(prev.disappearedAt ? { reappearedAt: now } : {}),
        },
      });
    }
  }

  // Anything previously seen and not in the visible set, not already marked gone.
  for (const o of existing) {
    if (visibleIds.has(o.loanId) || o.disappearedAt) continue;
    await prisma.lendingLoanObservation.update({
      where: { id: o.id },
      data: {
        disappearedAt: now,
        disappearedAfterLedger: o.lastObservedLedger,
        disappearedBeforeLedger: ledgerIndex,
      },
    });
  }

  const fresh = await prisma.lendingLoanObservation.findMany({ where: { borrower }, orderBy: { firstObservedAt: "asc" } });
  return buildObsBundle(fresh, visibleIds);
}

function buildObsBundle(
  obs: Array<{
    loanId: string; loanBrokerId: string; lastKnownStatus: string; everDefaulted: boolean; everImpaired: boolean;
    firstObservedAt: Date; lastObservedAt: Date; disappearedAt: Date | null;
    disappearedAfterLedger: number | null; disappearedBeforeLedger: number | null;
  }>,
  visibleIds: Set<string> | null
): ObsBundle {
  const everObservedLoans = obs.length > 0;
  const firstObservedAt = everObservedLoans ? obs[0].firstObservedAt.toISOString() : null;
  const gone = obs.filter((o) => o.disappearedAt != null || (visibleIds && !visibleIds.has(o.loanId)));
  const goneWithBad = gone.filter(
    (o) => o.everDefaulted || o.everImpaired || o.lastKnownStatus === "defaulted" || o.lastKnownStatus === "impaired"
  );
  const currentlyVisible = visibleIds ? obs.filter((o) => visibleIds.has(o.loanId)).length : obs.filter((o) => !o.disappearedAt).length;

  let note: string;
  if (!everObservedLoans) {
    note =
      "XRPLHub has never observed a loan for this borrower. This is NOT proof the borrower has never borrowed " +
      "— it means no loan has been visible on any of our checks. Our observation of this borrower begins now.";
  } else if (gone.length === 0) {
    note = `All ${obs.length} loan(s) ever observed for this borrower are still on the ledger.`;
  } else {
    note =
      `${gone.length} loan(s) previously observed for this borrower are no longer on the ledger. XLS-66 lets ` +
      `either the borrower or the broker delete a paid or defaulted loan (reclaiming the borrower's reserve). ` +
      `${goneWithBad.length} of those were last seen defaulted or impaired. See vanishedLoans / ` +
      `GET /api/lending/history?borrower= for the last-known state of each.`;
  }

  return {
    everObservedLoans,
    vanished: gone.map((o) => ({
      loanId: o.loanId,
      loanBrokerId: o.loanBrokerId,
      lastKnownStatus: o.lastKnownStatus,
      everDefaulted: o.everDefaulted,
      everImpaired: o.everImpaired,
      firstObservedAt: o.firstObservedAt.toISOString(),
      lastObservedAt: o.lastObservedAt.toISOString(),
      disappearedAfterLedger: o.disappearedAfterLedger,
      disappearedBeforeLedger: o.disappearedBeforeLedger,
    })),
    summary: {
      everObservedLoans,
      firstObservedAt,
      totalLoansEverObserved: obs.length,
      currentlyVisible,
      vanished: gone.length,
      vanishedLastSeenDefaultedOrImpaired: goneWithBad.length,
      note,
    },
  };
}

// ── decimal string helpers (NUMBER values from the ledger) ────────────────────
// XRPL NUMBER is at most 16 significant digits; JS Number is exact enough here,
// and we re-serialise with trailing zeros trimmed for canonical stability.
function addDecimal(a: string, b: string): string {
  const n = Number(a) + Number(b);
  if (!Number.isFinite(n)) return a;
  // up to 15 fractional digits, trim trailing zeros
  return n.toFixed(15).replace(/\.?0+$/, "") || "0";
}
function raw(iso: string | null): number {
  return iso ? Math.floor(new Date(iso).getTime() / 1000) - RIPPLE_EPOCH_OFFSET : 0;
}
/** 40-hex currency -> ASCII code (e.g. "524C5553440000…" -> "RLUSD"), for display
 *  only. The canonical asset key keeps the raw ledger value. */
function decodeCurrency(cur: string): string | null {
  if (!/^[0-9A-Fa-f]{40}$/.test(cur)) return null;
  const buf = Buffer.from(cur, "hex");
  let s = "";
  for (const b of buf) {
    if (b === 0) break;
    if (b < 0x20 || b > 0x7e) return null;
    s += String.fromCharCode(b);
  }
  return s.length >= 3 ? s : null;
}

// ── Discovery schemas ────────────────────────────────────────────────────────

export const LENDING_EXPOSURE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    borrower: {
      type: "string",
      pattern: "^r[1-9A-HJ-NP-Za-km-z]{24,34}$",
      description: "XRPL classic address (r...) of the borrower to aggregate lending exposure for.",
      example: "rEjXbJh2hwn2SVME1EvdCiH6TnU5TEpvf",
    },
  },
  required: ["borrower"],
} as const;

export const LENDING_EXPOSURE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    borrower: { type: "string" },
    amendmentActive: { type: "boolean", description: "false = XLS-66 not yet enabled on mainnet; response still carries the XRPLScore." },
    ledgerIndex: { type: "integer" },
    ledgerCloseAt: { type: "string", format: "date-time", nullable: true },
    disposition: {
      type: "string",
      enum: ["amendment-not-active", "active-exposure", "history-only", "no-loans-ever"],
      description: "no-loans-ever = we have never observed a loan (not proof of none). history-only = loans were observed before but none are on the ledger now.",
    },
    exposure: {
      type: "object",
      properties: {
        byAsset: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              principalOutstanding: { type: "string" },
              totalValueOutstanding: { type: "string", description: "principal + scheduled interest + mgmt fee still owed." },
              loanCount: { type: "integer" },
              currency: { type: "string" },
              issuer: { type: "string" },
              mptIssuanceId: { type: "string" },
            },
          },
          description: "Keyed by asset: 'XRP', '<currency>.<issuer>', or 'MPT:<id>'.",
        },
        loanCount: { type: "integer", description: "Loan objects visible on the ledger now." },
        brokerCount: { type: "integer", description: "distinct loan brokers." },
      },
    },
    events: {
      type: "object",
      properties: {
        defaulted: { type: "integer" },
        impaired: { type: "integer" },
        overdue: { type: "integer" },
        overdueGraceExpired: { type: "integer", description: "past NextPaymentDueDate + GracePeriod — a broker can default it now." },
      },
    },
    worstStatus: { type: "string", enum: ["none", "current", "overdue", "overdueGraceExpired", "impaired", "defaulted", "paid"] },
    earliestNextPaymentDue: { type: "string", format: "date-time", nullable: true },
    xrplScore: { type: "integer", nullable: true },
    grade: { type: "string", nullable: true },
    observation: {
      type: "object",
      properties: {
        everObservedLoans: { type: "boolean" },
        firstObservedAt: { type: "string", format: "date-time", nullable: true, description: "when XRPLHub first saw ANY loan for this borrower — history before this is invisible to us." },
        totalLoansEverObserved: { type: "integer" },
        currentlyVisible: { type: "integer" },
        vanished: { type: "integer", description: "loans we observed before that are no longer on the ledger (deleted by borrower or broker)." },
        vanishedLastSeenDefaultedOrImpaired: { type: "integer", description: "of the vanished, the ones last seen in default or impairment." },
        note: { type: "string" },
      },
    },
    leafHash: { type: "string", description: "SHA-256(0x00 || canonical leaf). This snapshot is Merkle-anchored on-ledger daily; verify at /api/attest/verify?queryId=." },
    disclaimer: { type: "string" },
  },
  required: ["borrower", "amendmentActive", "disposition", "exposure", "events", "observation", "disclaimer"],
} as const;

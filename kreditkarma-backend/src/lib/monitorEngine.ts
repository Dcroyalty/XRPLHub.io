// src/lib/monitorEngine.ts
// Continuous monitoring: layered on top of underwriting, not a replacement for it.
// Underwriting judges structural risk BEFORE signing; this reports OBSERVED behavioral
// changes in public XRP Ledger data AFTER — once a day, for wallets a subscriber chose.
//
// Shape:  evaluateSubject()  — pure decision logic over injected reads (fully unit-tested)
//         processSubjects()  — persistence: observation + outbox events + next state, one txn each
//         runMonitorPass()   — the daily pass (budget-aware, stalest-first, resumable by nextCheckAt)
//         baselineSubjects() — the same processing, run synchronously at subscribe time
//
// Discipline (same as every other attestation here):
//   • a score in an observation is FRESH (scoreWallet() called directly — never the display cache;
//     scripts/check-attestation-freshness.mjs enforces it). Unchanged wallets carry null + a pointer.
//   • a degraded / unreadable read NEVER produces a score, an event, or an all-clear: the check is
//     recorded as failed, and three in a row raise `monitoring_degraded` (which says nothing about the wallet).
//   • no default-probability alert, no recommendation. score_drop only fires against a threshold the
//     SUBSCRIBER set (there is no stored basis for a default).

import { createHash, randomUUID } from "crypto";
import type { PrismaClient, Prisma } from "@prisma/client";
import {
  MONITOR_ENGINE_VERSION,
  MONITOR_CANON_VERSION,
  LOAN_STATUSES,
  canonMonitorJson,
  monitorLeafHash,
  type MonitorLeaf,
  type MonitorSanctions,
  type MonitorLoans,
  type ObservationKind,
  type LoanStatusKey,
  type AccountStatus,
  type ScoreStatus,
} from "./monitorCanon";
import { scoreWallet, AccountNotFoundError } from "./xrplscore";
import { xrplRpc } from "./xrplNodes";
import { screenAddress } from "./screen";
import { currentSnapshot, LIST_NAMES } from "./sanctionLists";
import { recogniseAddress } from "./chainAddress";
import { lendingProtocolActive, validatedLedger, fetchBorrowerLoans } from "./lendingLedger";
import { deriveLoanStatus, runExposureQuery } from "./lendingExposure";
import { notifyError } from "./notify";
import { deliverDueEvents, type DeliveryStats, type Poster } from "./monitorWebhook";

export const RESCORE_AFTER_MS = 7 * 24 * 3600_000; // scores drift with time even when nothing happens
export const HEARTBEAT_AFTER_MS = 7 * 24 * 3600_000;
export const RECHECK_AFTER_MS = 12 * 3600_000; // due again by the next daily cron
export const DEGRADED_AFTER_FAILURES = 3;
/** Fresh scores (≈300+ RPC units each) one pass will compute. A daily cron run is ≤60s shared with other jobs. */
export const DEFAULT_SCORE_BUDGET = 100;
/** Total watched wallets across ALL customers — what the one daily monitoring run (06:00 UTC cron) can honestly keep up with. Env-overridable. */
export function maxTotalSubjects(): number {
  const n = Number(process.env.MONITOR_MAX_TOTAL_SUBJECTS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 500;
}

export type EventType =
  | "score_drop"
  | "sanctions_hit"
  | "sanctions_delisted"
  | "first_loan_observed"
  | "loan_overdue"
  | "loan_impaired"
  | "loan_defaulted"
  | "monitoring_degraded";

export const EVENT_TYPES: EventType[] = [
  "score_drop",
  "sanctions_hit",
  "sanctions_delisted",
  "first_loan_observed",
  "loan_overdue",
  "loan_impaired",
  "loan_defaulted",
  "monitoring_degraded",
];

// ── State + dependency shapes ────────────────────────────────────────────────
export interface SubjectState {
  address: string;
  /** xrpl | evm | btc | tron. Non-xrpl subjects get the SANCTIONS check only. */
  chain: string;
  /** What attested screening receipts written for this subject are stamped with: "monitor:<apiKeyId>". */
  keyRef: string;
  lastCheckedAt: Date | null;
  lastObservationAt: Date | null;
  lastSeenFingerprint: string | null;
  scoredFingerprint: string | null;
  lastScoredAt: Date | null;
  lastScore: number | null;
  lastMethodology: string | null;
  scorePeak: number | null;
  peakMethodology: string | null;
  lastScoredObservationId: string | null;
  sanctionListed: boolean | null;
  lastSanctions: MonitorSanctions | null;
  lastScreenSnapshotId: string | null;
  everHadLoan: boolean;
  loanStates: Record<string, string> | null;
  consecutiveFailures: number;
  degradedNotifiedAt: Date | null;
}

export interface SubscriptionCfg {
  scoreDropPoints: number | null;
}

export interface MonitorDeps {
  fingerprint(address: string): Promise<{ ok: true; accountStatus: AccountStatus; latestTxHash: string | null } | { ok: false }>;
  score(address: string): Promise<
    | { ok: true; score: number; grade: string; methodology: string; signals: Record<string, number> }
    | { ok: false; reason: "not_activated" | "unavailable" }
  >;
  /** Cheap exact-match membership of the address in the CURRENT snapshot of EVERY list — no receipt is written. */
  sanctionsMembership(address: string, chain: string, lists: SanctionSetSnapshot[]): Promise<{ ok: true; listed: boolean; matchedLists: string[] } | { ok: false }>;
  /** Full attested screening receipt naming every list (written at baseline and when listed-ness changes). */
  screen(
    address: string,
    chain: string,
    requestedBy: string
  ): Promise<
    | {
        ok: true;
        listed: boolean;
        receiptQueryId: string;
        screenedAt: string;
        snapshotId: string;
        matches: Array<{ list: string; entryId: string; entryName: string }>;
      }
    | { ok: false }
  >;
  loans(address: string, nowRippleSec: number): Promise<
    { ok: true; loans: Array<{ id: string; brokerId: string; status: LoanStatusKey }> } | { ok: false }
  >;
  /** Persist an attested exposure snapshot (best effort — its failure never fails the check). */
  attestLoans(address: string): Promise<void>;
  newId(): string;
}

/** One list's current snapshot, as the sanctions step needs it. */
export interface SanctionSetSnapshot {
  name: string;
  id: string;
  vintage: string;
  sha256: string;
  archiveVersion: number;
  coverage: Record<string, number>;
}

const listCovers = (l: SanctionSetSnapshot, chain: string) => (l.archiveVersion < 2 ? chain === "xrpl" : l.coverage[chain] !== undefined);

export interface CheckContext {
  now: Date;
  ledger: { index: number; closeAt: Date | null };
  /** The current snapshot of every list, or null if ANY list has none (the sanctions step then FAILS — it never checks fewer lists). */
  sanctionLists: SanctionSetSnapshot[] | null;
  loansActive: boolean;
  scoreBudget: { remaining: number };
}

export interface EventDraft {
  type: EventType;
  data: Record<string, unknown>;
}

export interface NextState extends Partial<SubjectState> {
  nextCheckAt: Date;
}

export type CheckResult =
  | { outcome: "failed"; reason: string }
  | {
      outcome: "checked";
      observation: { leaf: MonitorLeaf } | null;
      events: EventDraft[];
      next: NextState;
      attestLoans: boolean;
    };

const RIPPLE_EPOCH_OFFSET = 946_684_800;

function statusCounts(loans: Array<{ status: LoanStatusKey }>): Record<LoanStatusKey, number> {
  const c = Object.fromEntries(LOAN_STATUSES.map((s) => [s, 0])) as Record<LoanStatusKey, number>;
  for (const l of loans) c[l.status]++;
  return c;
}
const SEVERITY: Record<LoanStatusKey, number> = { defaulted: 5, impaired: 4, overdueGraceExpired: 3, overdue: 2, current: 1, paid: 0 };
function worst(loans: Array<{ status: LoanStatusKey }>): string {
  if (!loans.length) return "none";
  return loans.reduce((a, l) => (SEVERITY[l.status] > SEVERITY[a] ? l.status : a), loans[0].status);
}

/**
 * The list-set descriptor written into a leaf's `sanctions` block. Canon "monitor-observation-v1" (frozen) has three single-list
 * strings — `list`, `vintage`, `sha256`. With several lists they carry the SET, deterministically:
 *   list    = names joined with "+"                          e.g. "EU-FSF+OFAC-SDN+UK-SL"
 *   vintage = "<name>@<vintage>" joined with ";"             e.g. "EU-FSF@2026-09-22;OFAC-SDN@2026-09-23;UK-SL@2026-09-21"
 *   sha256  = SHA-256 of the lines "<name>:<snapshot sha256>" (sorted by name, joined by \n) — the list-set hash
 * The receipt named by `receiptQueryId` (a "sanctions-screen-v2" receipt) carries each list's own version, file hash and
 * per-chain address count, and is the authority.
 */
export function sanctionSetDescriptor(lists: Array<{ name: string; vintage: string; sha256: string }>): { list: string; vintage: string; sha256: string } {
  const sorted = [...lists].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    list: sorted.map((l) => l.name).join("+"),
    vintage: sorted.map((l) => `${l.name}@${l.vintage}`).join(";"),
    sha256: createHash("sha256").update(sorted.map((l) => `${l.name}:${l.sha256}`).join("\n"), "utf8").digest("hex"),
  };
}

/**
 * Decide what one check of one subject observed. Reads go through `deps`; nothing here touches the
 * database, so every branch is unit-testable. Returns `failed` whenever a REQUIRED read could not be
 * completed — no observation, no event, no score.
 *
 * A subject on the XRP Ledger gets the full check (account state, fresh score, sanctions, loans). A subject on another
 * chain (EVM / Bitcoin / Tron — a counterparty a VASP screens) has none of that to observe: it gets the SANCTIONS check only,
 * and its observations say `accountStatus: "not_applicable"`.
 */
export async function evaluateSubject(state: SubjectState, cfg: SubscriptionCfg, deps: MonitorDeps, ctx: CheckContext): Promise<CheckResult> {
  const now = ctx.now;
  const isBaseline = state.lastCheckedAt === null;
  const isXrpl = state.chain === "xrpl";
  const events: EventDraft[] = [];

  // 1. account-state fingerprint (cheap) — XRP Ledger subjects only
  let fingerprint: string | null = null;
  let fingerprintChanged = false;
  let fpStatus: AccountStatus = "not_applicable";
  if (isXrpl) {
    const fp = await deps.fingerprint(state.address);
    if (!fp.ok) return { outcome: "failed", reason: "account state could not be read from the XRP Ledger" };
    fingerprint = fp.latestTxHash;
    fpStatus = fp.accountStatus;
    fingerprintChanged = !isBaseline && fingerprint !== state.lastSeenFingerprint;
  }

  // 2. score — FRESH or not at all (XRP Ledger subjects only)
  const scoreDue =
    isXrpl &&
    fpStatus === "active" &&
    (state.lastScoredAt === null ||
      state.scoredFingerprint !== fingerprint ||
      now.getTime() - state.lastScoredAt.getTime() >= RESCORE_AFTER_MS);
  let scoreStatus: ScoreStatus;
  let xrplScore: number | null = null;
  let methodology: string | null = null;
  let grade: string | null = null;
  let signals: Record<string, number> | null = null;
  let accountStatus: AccountStatus = fpStatus;
  let scoreDeferred = false;

  if (scoreDue && ctx.scoreBudget.remaining > 0) {
    ctx.scoreBudget.remaining--;
    const s = await deps.score(state.address);
    if (s.ok) {
      scoreStatus = "fresh";
      xrplScore = s.score;
      methodology = s.methodology;
      grade = s.grade;
      signals = s.signals;
    } else if (s.reason === "not_activated") {
      accountStatus = "not_activated";
      scoreStatus = "unavailable";
    } else {
      return { outcome: "failed", reason: "the score could not be computed (XRP Ledger data unavailable)" };
    }
  } else {
    if (scoreDue) scoreDeferred = true; // over this pass's fresh-score budget — try again next pass
    scoreStatus = state.lastScoredObservationId ? "not_rescored" : "unavailable";
  }

  // 3. sanctions — a cheap membership check against the CURRENT snapshot of EVERY list, every check. The lists publish
  //    often but the addresses on them rarely change, so an attested screening receipt (which names every list, its
  //    version and its hash) is written only at baseline and when this subject's listed-ness changes.
  //    If the lists are not all ready the check FAILS (no observation, no all-clear) — it never silently checks fewer lists.
  let sanctions: MonitorSanctions | null = state.lastSanctions;
  let lastScreenSnapshotId = state.lastScreenSnapshotId;
  let sanctionListed = state.sanctionListed;
  let sanctionsChanged = false;
  {
    if (!ctx.sanctionLists) return { outcome: "failed", reason: "the sanctions lists are not all available yet" };
    const lists = ctx.sanctionLists;
    if (lists.some((l) => !listCovers(l, state.chain))) return { outcome: "failed", reason: "a sanctions list does not yet cover this address type" };
    const desc = sanctionSetDescriptor(lists);
    const m = await deps.sanctionsMembership(state.address, state.chain, lists);
    if (!m.ok) return { outcome: "failed", reason: "the sanctions lists could not be read" };
    let listed = m.listed;
    let receiptQueryId = state.lastSanctions?.receiptQueryId ?? null;
    let matches: Array<{ list: string; entryId: string; entryName: string }> = [];
    let matchedLists: string[] = m.matchedLists;
    if (isBaseline || m.listed !== state.sanctionListed || receiptQueryId === null) {
      const sc = await deps.screen(state.address, state.chain, state.keyRef);
      if (!sc.ok) return { outcome: "failed", reason: "the sanctions screen could not be completed" };
      listed = sc.listed; // the attested receipt is authoritative
      receiptQueryId = sc.receiptQueryId;
      matches = sc.matches;
      matchedLists = [...new Set(sc.matches.map((x) => x.list))];
      lastScreenSnapshotId = sc.snapshotId;
    }
    const prev = state.sanctionListed;
    const base = { lists: lists.map((l) => ({ name: l.name, vintage: l.vintage, sha256: l.sha256 })), receiptQueryId, subjectChain: state.chain };
    if (listed && prev !== true) {
      const first = matches[0] ? lists.find((l) => l.name === matches[0].list) : undefined;
      events.push({
        type: "sanctions_hit",
        data: {
          // `list`/`vintage`/`sha256` (the list the address was found on) keep their original meaning for existing subscribers;
          // `lists` names EVERY list that was checked, and `matches` says where it was found.
          list: matches[0]?.list ?? desc.list,
          vintage: first?.vintage ?? desc.vintage,
          sha256: first?.sha256 ?? desc.sha256,
          matchedLists,
          matches,
          ...base,
          atSubscription: isBaseline,
          note: "Exact address-string match against the list version(s) named. Not a legal or compliance determination.",
        },
      });
    } else if (!listed && prev === true) {
      events.push({
        type: "sanctions_delisted",
        data: {
          list: desc.list,
          vintage: desc.vintage,
          sha256: desc.sha256,
          previouslyListedOn: state.lastSanctions?.matchedLists ?? null,
          ...base,
          note: "The address did not appear on the list version(s) named; it had appeared on an earlier one.",
        },
      });
    }
    sanctionsChanged = isBaseline || prev !== listed;
    sanctionListed = listed;
    sanctions = { listed, ...desc, checkedAt: now.toISOString(), receiptQueryId: receiptQueryId as string, matchedLists: listed ? matchedLists : [] };
  }

  // 4. loans — only while XLS-66 is enabled (read from the ledger each pass); XRP Ledger subjects only
  let loansBlock: MonitorLoans = { amendmentActive: false, loanCount: null, worstStatus: null, statusCounts: null };
  let loanStates: Record<string, string> | null = state.loanStates;
  let everHadLoan = state.everHadLoan;
  let loansChanged = false;
  if (isXrpl && ctx.loansActive) {
    const nowRipple = (ctx.ledger.closeAt ? Math.floor(ctx.ledger.closeAt.getTime() / 1000) : Math.floor(now.getTime() / 1000)) - RIPPLE_EPOCH_OFFSET;
    const l = await deps.loans(state.address, nowRipple);
    if (!l.ok) return { outcome: "failed", reason: "loan objects could not be read from the XRP Ledger" };
    loansBlock = { amendmentActive: true, loanCount: l.loans.length, worstStatus: worst(l.loans), statusCounts: statusCounts(l.loans) };
    const prevStates = state.loanStates ?? {};
    const nextStates: Record<string, string> = {};
    for (const loan of l.loans) {
      nextStates[loan.id] = loan.status;
      const prev = prevStates[loan.id];
      if (prev === loan.status) continue;
      const base = { loanId: loan.id, loanBrokerId: loan.brokerId, previousStatus: prev ?? null, status: loan.status, atSubscription: isBaseline };
      if (loan.status === "overdue" || loan.status === "overdueGraceExpired") {
        if (prev !== "overdue" && prev !== "overdueGraceExpired") events.push({ type: "loan_overdue", data: base });
      } else if (loan.status === "impaired") {
        events.push({ type: "loan_impaired", data: base });
      } else if (loan.status === "defaulted") {
        events.push({ type: "loan_defaulted", data: base });
      }
    }
    if (!everHadLoan && l.loans.length > 0 && !isBaseline) {
      events.push({ type: "first_loan_observed", data: { loanCount: l.loans.length, loans: l.loans.map((x) => ({ loanId: x.id, loanBrokerId: x.brokerId, status: x.status })) } });
    }
    if (l.loans.length > 0) everHadLoan = true;
    loansChanged = JSON.stringify(prevStates) !== JSON.stringify(nextStates);
    loanStates = nextStates;
  }

  // 5. score_drop — measured from the highest fresh score since subscribe / the last alert, against
  //    the SUBSCRIBER's threshold. No threshold set => no score_drop events (there is no default).
  let scorePeak = state.scorePeak;
  let peakMethodology = state.peakMethodology;
  let scoreChanged = false;
  if (scoreStatus === "fresh" && xrplScore !== null && methodology) {
    scoreChanged = state.lastScore !== xrplScore || state.lastMethodology !== methodology;
    if (scorePeak === null || peakMethodology !== methodology) {
      scorePeak = xrplScore; // first score, or the methodology changed: re-baseline silently, never alert across versions
      peakMethodology = methodology;
    } else if (xrplScore > scorePeak) {
      scorePeak = xrplScore;
    } else if (cfg.scoreDropPoints !== null && scorePeak - xrplScore >= cfg.scoreDropPoints) {
      events.push({
        type: "score_drop",
        data: { previousPeak: scorePeak, score: xrplScore, dropPoints: scorePeak - xrplScore, thresholdPoints: cfg.scoreDropPoints, grade, methodology, signals, note: "Measured from the highest fresh score observed since you subscribed or since the last score_drop alert." },
      });
      scorePeak = xrplScore;
    }
  }

  // 6. is there an observation to write?
  const changed = fingerprintChanged || scoreChanged || sanctionsChanged || loansChanged || (isBaseline);
  const heartbeatDue = state.lastObservationAt === null || now.getTime() - state.lastObservationAt.getTime() >= HEARTBEAT_AFTER_MS;
  let kind: ObservationKind | null = null;
  if (isBaseline) kind = "baseline";
  else if (events.length) kind = "event";
  else if (changed) kind = "change";
  else if (heartbeatDue) kind = "heartbeat";

  let observation: { leaf: MonitorLeaf } | null = null;
  const observationId = deps.newId();
  if (kind) {
    observation = {
      leaf: {
        observationId,
        subject: state.address,
        kind,
        accountStatus,
        ledgerIndex: ctx.ledger.index,
        ledgerCloseAt: ctx.ledger.closeAt ? ctx.ledger.closeAt.toISOString() : null,
        fingerprint,
        xrplScore: scoreStatus === "fresh" ? xrplScore : null,
        scoreStatus,
        scoreObservationRef: scoreStatus === "not_rescored" ? state.lastScoredObservationId : null,
        methodology: scoreStatus === "fresh" ? methodology : null,
        sanctions,
        loans: loansBlock,
        eventTypes: [...new Set(events.map((e) => e.type))].sort(),
        engineVersion: MONITOR_ENGINE_VERSION,
        generatedAt: now.toISOString(),
      },
    };
  }

  const wroteFresh = !!observation && scoreStatus === "fresh";
  const next: NextState = {
    nextCheckAt: scoreDeferred ? now : new Date(now.getTime() + RECHECK_AFTER_MS),
    lastCheckedAt: now,
    lastSeenFingerprint: fingerprint,
    consecutiveFailures: 0,
    degradedNotifiedAt: null,
    sanctionListed,
    lastSanctions: sanctions,
    lastScreenSnapshotId,
    everHadLoan,
    loanStates,
    scorePeak,
    peakMethodology,
  };
  if (observation) next.lastObservationAt = now;
  if (scoreStatus === "fresh" && xrplScore !== null) {
    next.scoredFingerprint = fingerprint;
    next.lastScoredAt = now;
    next.lastScore = xrplScore;
    next.lastMethodology = methodology;
    if (wroteFresh) next.lastScoredObservationId = observationId;
  }
  return { outcome: "checked", observation, events, next, attestLoans: isXrpl && ctx.loansActive && (loansChanged || events.some((e) => e.type.startsWith("loan_") || e.type === "first_loan_observed")) };
}

// ── Real dependencies ────────────────────────────────────────────────────────
export function realDeps(prisma: PrismaClient, requestedBy: string): MonitorDeps {
  return {
    async fingerprint(address) {
      const [tx, info] = await Promise.all([
        xrplRpc("account_tx", { account: address, limit: 1, ledger_index_min: -1, ledger_index_max: -1 }),
        xrplRpc("account_info", { account: address, ledger_index: "validated" }),
      ]);
      if (!tx.ok || !info.ok) return { ok: false };
      const infoRes = (info.body as { result?: { account_data?: unknown; error?: string } }).result;
      if (!infoRes?.account_data) {
        if (infoRes?.error === "actNotFound") return { ok: true, accountStatus: "not_activated", latestTxHash: null };
        return { ok: false }; // tooBusy / malformed: a read failure, not a missing wallet
      }
      const txRes = (tx.body as { result?: { transactions?: Array<{ tx?: { hash?: string }; hash?: string; tx_json?: { hash?: string } }>; error?: string } }).result;
      if (txRes?.error || !Array.isArray(txRes?.transactions)) return { ok: false };
      const t = txRes!.transactions![0];
      return { ok: true, accountStatus: "active", latestTxHash: t ? (t.tx?.hash ?? t.hash ?? t.tx_json?.hash ?? null) : null };
    },
    async score(address) {
      try {
        const r = await scoreWallet(address); // FRESH — never the display cache
        return { ok: true, score: r.ledgerScore, grade: r.grade, methodology: r.methodology, signals: r.signals };
      } catch (e) {
        if (e instanceof AccountNotFoundError) return { ok: false, reason: "not_activated" };
        return { ok: false, reason: "unavailable" };
      }
    },
    async sanctionsMembership(address, chain, lists) {
      try {
        const rec = recogniseAddress(address);
        if (!rec || rec.chain !== chain) return { ok: false };
        const matchedLists: string[] = [];
        for (const l of lists) {
          const where = l.archiveVersion < 2 ? { snapshotId: l.id, address: rec.address } : { snapshotId: l.id, chain: rec.chain, addressNorm: rec.normalized };
          const hit = await prisma.sanctionedAddress.findFirst({ where, select: { id: true } });
          if (hit) matchedLists.push(l.name);
        }
        return { ok: true, listed: matchedLists.length > 0, matchedLists };
      } catch {
        return { ok: false };
      }
    },
    async screen(address, _chain, screenRequestedBy) {
      try {
        const led = await validatedLedger();
        const o = await screenAddress(prisma, address, screenRequestedBy, led.index); // every list; the receipt names each one
        const res = o.leaf.result;
        return {
          ok: true,
          listed: res.listed,
          receiptQueryId: o.queryId,
          screenedAt: o.leaf.screenedAt,
          snapshotId: o.snapshotId,
          matches: res.listed ? res.matches.map((m) => ({ list: m.list, entryId: m.entryId, entryName: m.entryName })) : [],
        };
      } catch {
        return { ok: false };
      }
    },
    async loans(address, nowRippleSec) {
      try {
        const raw = await fetchBorrowerLoans(address); // throws when the ledger cannot be read
        return { ok: true, loans: raw.map((l) => ({ id: l.index, brokerId: l.LoanBrokerID, status: deriveLoanStatus(l, nowRippleSec) as LoanStatusKey })) };
      } catch {
        return { ok: false };
      }
    },
    async attestLoans(address) {
      try {
        await runExposureQuery(prisma, address, requestedBy); // persists an attested exposure snapshot
      } catch (e) {
        await notifyError("monitor attest-loans", e, { address });
      }
    },
    newId: () => randomUUID(),
  };
}

// ── Persistence ──────────────────────────────────────────────────────────────
type SubjectRow = Prisma.MonitorSubjectGetPayload<{ include: { subscription: true } }>;

function toState(r: SubjectRow): SubjectState {
  return {
    address: r.address,
    chain: r.chain,
    keyRef: `monitor:${r.subscription.apiKeyId}`,
    lastCheckedAt: r.lastCheckedAt,
    lastObservationAt: r.lastObservationAt,
    lastSeenFingerprint: r.lastSeenFingerprint,
    scoredFingerprint: r.scoredFingerprint,
    lastScoredAt: r.lastScoredAt,
    lastScore: r.lastScore,
    lastMethodology: r.lastMethodology,
    scorePeak: r.scorePeak,
    peakMethodology: r.peakMethodology,
    lastScoredObservationId: r.lastScoredObservationId,
    sanctionListed: r.sanctionListed,
    lastSanctions: (r.lastSanctions as unknown as MonitorSanctions | null) ?? null,
    lastScreenSnapshotId: r.lastScreenSnapshotId,
    everHadLoan: r.everHadLoan,
    loanStates: (r.loanStates as unknown as Record<string, string> | null) ?? null,
    consecutiveFailures: r.consecutiveFailures,
    degradedNotifiedAt: r.degradedNotifiedAt,
  };
}

export interface PassResult {
  ran: boolean;
  reason?: string;
  due: number;
  checked: number;
  failed: number;
  observations: number;
  events: number;
  freshScores: number;
  deferredForBudget: number;
  remainingDue: number;
  degradedRaised: number;
  loansEvaluated: boolean;
  totalSubjects: number;
  delivery?: DeliveryStats;
}

/** Current snapshot of EVERY list, or null if any list has none. */
async function loadSanctionLists(prisma: PrismaClient): Promise<SanctionSetSnapshot[] | null> {
  const out: SanctionSetSnapshot[] = [];
  for (const name of LIST_NAMES) {
    const snap = await currentSnapshot(prisma, name).catch(() => null);
    if (!snap) return null;
    out.push({ name, id: snap.id, vintage: snap.vintage, sha256: snap.sha256, archiveVersion: snap.archiveVersion, coverage: snap.coverage });
  }
  return out;
}

async function buildContext(prisma: PrismaClient, scoreBudget: number): Promise<CheckContext | null> {
  const ledger = await validatedLedger();
  if (!ledger.index) return null; // cannot pin a ledger => cannot attest anything
  const sanctionLists = await loadSanctionLists(prisma);
  return { now: new Date(), ledger, sanctionLists, loansActive: await lendingProtocolActive(), scoreBudget: { remaining: scoreBudget } };
}

async function persistOne(prisma: PrismaClient, row: SubjectRow, res: CheckResult, deps: MonitorDeps, ctx: CheckContext, tally: { events: number; observations: number; degradedRaised: number }, recordFailures = true): Promise<void> {
  const sub = row.subscription;
  if (res.outcome === "failed") {
    if (!recordFailures) return; // an in-request retry round: only the final round counts toward monitoring_degraded
    const failures = row.consecutiveFailures + 1;
    const raise = failures >= DEGRADED_AFTER_FAILURES && !row.degradedNotifiedAt;
    const ops: Prisma.PrismaPromise<unknown>[] = [
      prisma.monitorSubject.update({
        where: { id: row.id },
        data: { consecutiveFailures: failures, nextCheckAt: ctx.now, ...(raise ? { degradedNotifiedAt: ctx.now } : {}) },
      }),
    ];
    if (raise) {
      ops.push(
        prisma.monitorEvent.create({
          data: {
            subscriptionId: sub.id,
            subject: row.address,
            type: "monitoring_degraded",
            payload: { consecutiveFailedChecks: failures, message: `We could not complete the daily check for this wallet on ${failures} consecutive runs (${res.reason}). No observation was recorded. This says nothing about the wallet itself.` } as Prisma.InputJsonValue,
          },
        })
      );
      tally.events++;
      tally.degradedRaised++;
    }
    await prisma.$transaction(ops);
    return;
  }

  const ops: Prisma.PrismaPromise<unknown>[] = [];
  let observationId: string | null = null;
  if (res.observation) {
    const leaf = res.observation.leaf;
    observationId = leaf.observationId;
    const canonicalJson = canonMonitorJson(leaf); // throws if a non-fresh score would be recorded
    ops.push(
      prisma.monitorObservation.create({
        data: {
          observationId: leaf.observationId,
          apiKeyId: sub.apiKeyId,
          subject: row.address,
          kind: leaf.kind,
          ledgerIndex: leaf.ledgerIndex,
          ledgerCloseAt: leaf.ledgerCloseAt ? new Date(leaf.ledgerCloseAt) : null,
          recordJson: JSON.parse(canonicalJson) as Prisma.InputJsonValue,
          canonicalJson,
          leafHash: monitorLeafHash(leaf),
          canonVersion: MONITOR_CANON_VERSION,
          engineVersion: MONITOR_ENGINE_VERSION,
        },
      })
    );
    tally.observations++;
  }
  for (const ev of res.events) {
    ops.push(
      prisma.monitorEvent.create({
        data: { subscriptionId: sub.id, subject: row.address, type: ev.type, payload: ev.data as Prisma.InputJsonValue, observationId },
      })
    );
    tally.events++;
  }
  const n = res.next;
  ops.push(
    prisma.monitorSubject.update({
      where: { id: row.id },
      data: {
        nextCheckAt: n.nextCheckAt,
        lastCheckedAt: n.lastCheckedAt,
        ...(n.lastObservationAt !== undefined ? { lastObservationAt: n.lastObservationAt } : {}),
        lastSeenFingerprint: n.lastSeenFingerprint,
        ...(n.scoredFingerprint !== undefined ? { scoredFingerprint: n.scoredFingerprint } : {}),
        ...(n.lastScoredAt !== undefined ? { lastScoredAt: n.lastScoredAt } : {}),
        ...(n.lastScore !== undefined ? { lastScore: n.lastScore } : {}),
        ...(n.lastMethodology !== undefined ? { lastMethodology: n.lastMethodology } : {}),
        scorePeak: n.scorePeak,
        peakMethodology: n.peakMethodology,
        ...(n.lastScoredObservationId !== undefined ? { lastScoredObservationId: n.lastScoredObservationId } : {}),
        sanctionListed: n.sanctionListed,
        lastSanctions: (n.lastSanctions ?? undefined) as Prisma.InputJsonValue | undefined,
        lastScreenSnapshotId: n.lastScreenSnapshotId,
        everHadLoan: n.everHadLoan,
        loanStates: (n.loanStates ?? undefined) as Prisma.InputJsonValue | undefined,
        consecutiveFailures: 0,
        degradedNotifiedAt: null,
      },
    })
  );
  await prisma.$transaction(ops);
  if (res.attestLoans) await deps.attestLoans(row.address);
}

async function processSubjects(
  prisma: PrismaClient,
  rows: SubjectRow[],
  ctx: CheckContext,
  deps: MonitorDeps,
  opts: { deadlineMs: number; concurrency: number; recordFailures?: boolean }
): Promise<{ checked: number; failed: number; observations: number; events: number; degradedRaised: number; unprocessed: number }> {
  const tally = { events: 0, observations: 0, degradedRaised: 0 };
  let checked = 0;
  let failed = 0;
  let i = 0;
  const errors: string[] = [];
  async function worker() {
    while (Date.now() < opts.deadlineMs) {
      const idx = i++;
      if (idx >= rows.length) return;
      const row = rows[idx];
      try {
        const res = await evaluateSubject(toState(row), { scoreDropPoints: row.subscription.scoreDropPoints }, deps, ctx);
        await persistOne(prisma, row, res, deps, ctx, tally, opts.recordFailures ?? true);
        if (res.outcome === "checked") checked++;
        else failed++;
      } catch (e) {
        failed++;
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));
  if (errors.length) await notifyError("monitor pass", new Error(`${errors.length} subject check(s) threw: ${errors[0]}`), { count: errors.length });
  return { checked, failed, ...tally, unprocessed: Math.max(0, rows.length - Math.min(rows.length, i)) };
}

/** The daily pass. Stalest first; anything not reached keeps nextCheckAt <= now and is first in line next run. */
export async function runMonitorPass(
  prisma: PrismaClient,
  opts: { deadlineMs: number; deliverUntilMs?: number; scoreBudget?: number; concurrency?: number; deps?: MonitorDeps; limit?: number; poster?: Poster; onlySubscriptionIds?: string[] } = { deadlineMs: Date.now() + 25_000 }
): Promise<PassResult> {
  const totalSubjects = await prisma.monitorSubject.count({ where: { subscription: { status: { not: "deleted" } } } });
  const empty = (reason: string): PassResult => ({ ran: false, reason, due: 0, checked: 0, failed: 0, observations: 0, events: 0, freshScores: 0, deferredForBudget: 0, remainingDue: 0, degradedRaised: 0, loansEvaluated: false, totalSubjects });

  const ctx = await buildContext(prisma, opts.scoreBudget ?? DEFAULT_SCORE_BUDGET);
  if (!ctx) return empty("validated ledger unreadable — nothing can be pinned, no check was attempted");
  const budget0 = ctx.scoreBudget.remaining;
  const deps = opts.deps ?? realDeps(prisma, "monitor");

  const rows = await prisma.monitorSubject.findMany({
    where: { nextCheckAt: { lte: ctx.now }, subscription: { status: { in: ["active", "webhook_disabled"] } }, ...(opts.onlySubscriptionIds ? { subscriptionId: { in: opts.onlySubscriptionIds } } : {}) },
    orderBy: { nextCheckAt: "asc" },
    take: opts.limit ?? 400,
    include: { subscription: true },
  });
  const r = rows.length ? await processSubjects(prisma, rows, ctx, deps, { deadlineMs: opts.deadlineMs, concurrency: opts.concurrency ?? 4 }) : { checked: 0, failed: 0, observations: 0, events: 0, degradedRaised: 0, unprocessed: 0 };
  const remainingDue = await prisma.monitorSubject.count({ where: { nextCheckAt: { lte: new Date() }, subscription: { status: { in: ["active", "webhook_disabled"] } }, ...(opts.onlySubscriptionIds ? { subscriptionId: { in: opts.onlySubscriptionIds } } : {}) } });

  const delivery = await deliverDueEvents(prisma, { deadlineMs: opts.deliverUntilMs ?? Date.now() + 6_000, poster: opts.poster, onlySubscriptionIds: opts.onlySubscriptionIds });
  return {
    ran: true,
    due: rows.length,
    checked: r.checked,
    failed: r.failed,
    observations: r.observations,
    events: r.events,
    freshScores: budget0 - ctx.scoreBudget.remaining,
    deferredForBudget: ctx.scoreBudget.remaining <= 0 ? remainingDue : 0,
    remainingDue,
    degradedRaised: r.degradedRaised,
    loansEvaluated: ctx.loansActive,
    totalSubjects,
    delivery,
  };
}

/**
 * Baseline newly-added subjects immediately (synchronous, at subscribe time). A baseline needs a fresh score
 * (seven parallel XRPL reads); a transient node/rate-limit blip must not leave a new subscriber waiting a day,
 * so a subject that fails is retried up to two more times inside this request. Only the final round counts a
 * failure toward monitoring_degraded. Still-failing subjects stay 'pending' and the next daily run completes them.
 */
export async function baselineSubjects(
  prisma: PrismaClient,
  subjectIds: string[],
  opts: { deadlineMs: number; deps?: MonitorDeps; concurrency?: number; retryDelaysMs?: number[] }
): Promise<{ ran: boolean; reason?: string; pending: number }> {
  const ctx = await buildContext(prisma, 1000);
  if (!ctx) return { ran: false, reason: "validated ledger unreadable", pending: subjectIds.length };
  const deps = opts.deps ?? realDeps(prisma, "monitor");
  const delays = opts.retryDelaysMs ?? [2_000, 5_000];
  let rows = await prisma.monitorSubject.findMany({ where: { id: { in: subjectIds } }, include: { subscription: true } });
  for (let round = 0; round <= delays.length && rows.length && Date.now() < opts.deadlineMs; round++) {
    if (round > 0) await new Promise((r) => setTimeout(r, delays[round - 1]));
    await processSubjects(prisma, rows, ctx, deps, { deadlineMs: opts.deadlineMs, concurrency: opts.concurrency ?? 2, recordFailures: round === delays.length });
    rows = await prisma.monitorSubject.findMany({ where: { id: { in: rows.map((r) => r.id) }, lastCheckedAt: null }, include: { subscription: true } });
  }
  return { ran: true, pending: rows.length };
}

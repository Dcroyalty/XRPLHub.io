// src/lib/monitorCanon.ts
// FROZEN canonicalisation for continuous-monitoring observations — canonVersion
// "monitor-observation-v1". An observation attests to STATE OBSERVED: at ledger N /
// time T, wallet X had this account state, this fresh XRPLScore (or none), this
// sanctions-screen result and this loan state. It never asserts that a wallet is
// safe, risky, sanctioned-in-fact or likely to default.
//
// HARD RULE (same as every other attestation here): a score inside a leaf is FRESH.
// `xrplScore` is non-null only when `scoreStatus === "fresh"` — a score computed by
// scoreWallet() during THIS observation. A wallet whose account state did not change
// carries `xrplScore: null`, `scoreStatus: "not_rescored"` and a pointer
// (`scoreObservationRef`) to its last fresh scored observation. A reused number is
// never anchored as current. `canonMonitorJson` throws if a leaf breaks this.
//
// Leaf key order is load-bearing. Leaf hash / tree / root are byte-identical to the
// OFAC screening, MPT registry and lending anchors (RFC 6962, ./merkle).

import { leafHash } from "./merkle";

export const MONITOR_CANON_VERSION = "monitor-observation-v1";
// The ENGINE version (a promise about what a check does) moved to v2 on 2026-09-25: the sanctions step now checks every list and non-XRPL
// subjects are sanctions-only. The CANON (leaf keys, hashing, memo type) is unchanged and still "monitor-observation-v1".
export const MONITOR_ENGINE_VERSION = "monitor-engine-v2";
export const MONITOR_MEMO_TYPE = `XRPLHub-Monitor-Attestation/${MONITOR_CANON_VERSION}`;

/** Bump when the acknowledgement text changes; subscribers must accept the CURRENT version. */
export const CONSUMER_ACK_VERSION = "2026-09-20";
export const CONSUMER_ACK_TEXT =
  "I confirm that I will not use any output of the XRPLHub monitoring service — alone or combined with other " +
  "data — to make or communicate any decision about a consumer's eligibility for credit, insurance, employment, " +
  "housing, or any other purpose governed by the U.S. Fair Credit Reporting Act (FCRA) or the Equal Credit " +
  "Opportunity Act (ECOA). I understand monitoring reports observed changes in public XRP Ledger data, is not " +
  "underwriting, and does not estimate the probability that any wallet will default.";

export type ObservationKind = "baseline" | "change" | "event" | "heartbeat";
export type ScoreStatus = "fresh" | "not_rescored" | "unavailable";
/** "not_applicable": the subject is not on the XRP Ledger (a sanctions-only subject: EVM / Bitcoin / Tron address). */
export type AccountStatus = "active" | "not_activated" | "not_applicable";

export const LOAN_STATUSES = ["current", "overdue", "overdueGraceExpired", "impaired", "defaulted", "paid"] as const;
export type LoanStatusKey = (typeof LOAN_STATUSES)[number];

export interface MonitorSanctions {
  listed: boolean;
  // With several lists these three carry the SET (see sanctionSetDescriptor in monitorEngine.ts): names joined by "+", "<name>@<vintage>" joined by ";",
  // and the SHA-256 of the "<name>:<snapshot sha256>" lines. The receipt named below is the per-list authority.
  list: string; // e.g. "EU-FSF+OFAC-SDN+UK-SL"
  vintage: string; // e.g. "EU-FSF@2026-09-22;OFAC-SDN@2026-09-23;UK-SL@2026-09-21"
  sha256: string; // the list-set hash
  checkedAt: string; // RFC 3339 — when this membership check was made
  receiptQueryId: string; // the last attested ScreeningReceipt for this wallet (baseline or last listed-ness change)
  /** NOT part of the canonical leaf (canonMonitorJson picks explicit keys): which lists the address was found on. Kept in subject state only. */
  matchedLists?: string[];
}

export interface MonitorLoans {
  amendmentActive: boolean;
  loanCount: number | null; // null when the amendment is not active (not evaluated)
  worstStatus: string | null;
  statusCounts: Record<LoanStatusKey, number> | null;
}

export interface MonitorLeaf {
  observationId: string;
  subject: string;
  kind: ObservationKind;
  accountStatus: AccountStatus;
  ledgerIndex: number;
  ledgerCloseAt: string | null;
  fingerprint: string | null; // newest account_tx hash observed, or null (no transactions / not activated)
  xrplScore: number | null;
  scoreStatus: ScoreStatus;
  scoreObservationRef: string | null;
  methodology: string | null; // the scoring methodology string, only when freshly scored
  sanctions: MonitorSanctions | null;
  loans: MonitorLoans;
  eventTypes: string[]; // sorted
  engineVersion: string;
  generatedAt: string;
}

export const MONITOR_CANON_SPEC = {
  version: MONITOR_CANON_VERSION,
  engine: {
    version: MONITOR_ENGINE_VERSION,
    reads:
      "Per watched wallet, at most once per check: the newest account_tx entry + account_info (the account-state " +
      "fingerprint); a FRESH scoreWallet() only when the fingerprint changed since the last fresh score, the last " +
      "fresh score is over 7 days old, or none exists; an exact-match membership check of the wallet against the " +
      "current snapshot of every list (OFAC-SDN, EU-FSF, UK-SL) — with several lists the leaf's list/vintage/sha256 fields carry the list SET " +
      "and the receipt it names is the per-list authority (an attested screening receipt is written at baseline and whenever the wallet's " +
      "listed-ness changes); and, only while the XLS-66 amendment is enabled, the borrower's Loan objects. A subject on another chain " +
      "(EVM / Bitcoin / Tron) gets the sanctions check only and its observations say accountStatus \"not_applicable\".",
    sparse:
      "Observations are written on: subscription (baseline), any change in account state / score / sanctions / " +
      "loans (change), any emitted event (event), and at most weekly when nothing changed (heartbeat). A quiet day " +
      "writes nothing — history shows observation points, not proof of continuous coverage.",
    excludes:
      "No probability of default. No recommendation. No off-ledger data. No entity/name resolution. No counterparty " +
      "or graph analysis. Cannot see borrower credit, collateral, or legal structure. Not underwriting; not real-time " +
      "(the check runs once a day).",
  },
  record: {
    description:
      "Build a JSON object with EXACTLY these keys in this order, then JSON.stringify with no extra whitespace (UTF-8 bytes).",
    keys: [
      "observationId", // UUIDv4
      "subject", // the XRPL address watched
      "kind", // baseline | change | event | heartbeat
      "accountStatus", // active | not_activated | not_applicable (non-XRPL subject)
      "ledgerIndex", // validated ledger the observation was pinned to
      "ledgerCloseAt", // RFC 3339 UTC of that ledger's close, or null
      "fingerprint", // newest account_tx hash, or null
      "xrplScore", // integer 300-850 ONLY when scoreStatus == "fresh", else null
      "scoreStatus", // fresh | not_rescored | unavailable
      "scoreObservationRef", // observationId of the last fresh scored observation when not_rescored, else null
      "methodology", // scoring methodology string when fresh, else null
      "sanctions", // { listed, list, vintage, sha256, checkedAt, receiptQueryId } or null
      "loans", // { amendmentActive, loanCount, worstStatus, statusCounts }
      "eventTypes", // string[] sorted ascending
      "engineVersion", // "monitor-observation-v1"
      "generatedAt", // RFC 3339 UTC, millisecond precision, 'Z'
    ],
  },
  leaves: "Order the observations in an anchor batch by observationId ascending (byte order). Leaf hash = SHA-256( 0x00 || utf8(recordJson) ).",
  merkle:
    "RFC 6962 style. Internal node = SHA-256( 0x01 || left || right ). Odd node at a level promoted unchanged. Single-leaf root is that leaf hash. Empty tree root is SHA-256 of the empty string.",
  root: "Lowercase 64-char hex.",
  onLedger: {
    account: "r9dQS1oGms3B7SdY6nyU24Dy7dWyWXuJXb",
    transactionType: "AccountSet",
    memoType: MONITOR_MEMO_TYPE,
    memoFormat: "application/json",
    memoDataIs: "hex(UTF-8 JSON) — { v, root, leaves, rangeStart, rangeEnd, ts }. Its `root` field is the Merkle root.",
  },
} as const;

/** Throws if the leaf would put a non-fresh score (or a fresh score without its methodology) into the record. */
export function assertLeafFreshness(leaf: MonitorLeaf): void {
  if (leaf.scoreStatus === "fresh") {
    if (leaf.xrplScore === null || !Number.isInteger(leaf.xrplScore)) {
      throw new Error("monitor leaf: scoreStatus 'fresh' requires an integer xrplScore");
    }
    if (!leaf.methodology) throw new Error("monitor leaf: a fresh score must carry its methodology");
    if (leaf.scoreObservationRef !== null) throw new Error("monitor leaf: a fresh score carries no scoreObservationRef");
  } else {
    if (leaf.xrplScore !== null) throw new Error("monitor leaf: a score that was not freshly computed must be null");
    if (leaf.methodology !== null) throw new Error("monitor leaf: methodology is only recorded with a fresh score");
    if (leaf.scoreStatus === "unavailable" && leaf.scoreObservationRef !== null) {
      throw new Error("monitor leaf: 'unavailable' carries no scoreObservationRef");
    }
  }
}

/** Deterministic serialisation — explicit key order. Enforces the freshness rule. */
export function canonMonitorJson(leaf: MonitorLeaf): string {
  assertLeafFreshness(leaf);
  const s = leaf.sanctions
    ? {
        listed: leaf.sanctions.listed,
        list: leaf.sanctions.list,
        vintage: leaf.sanctions.vintage,
        sha256: leaf.sanctions.sha256,
        checkedAt: leaf.sanctions.checkedAt,
        receiptQueryId: leaf.sanctions.receiptQueryId,
      }
    : null;
  const c = leaf.loans.statusCounts;
  const loans = {
    amendmentActive: leaf.loans.amendmentActive,
    loanCount: leaf.loans.loanCount,
    worstStatus: leaf.loans.worstStatus,
    statusCounts: c
      ? {
          current: c.current,
          overdue: c.overdue,
          overdueGraceExpired: c.overdueGraceExpired,
          impaired: c.impaired,
          defaulted: c.defaulted,
          paid: c.paid,
        }
      : null,
  };
  return JSON.stringify({
    observationId: leaf.observationId,
    subject: leaf.subject,
    kind: leaf.kind,
    accountStatus: leaf.accountStatus,
    ledgerIndex: leaf.ledgerIndex,
    ledgerCloseAt: leaf.ledgerCloseAt,
    fingerprint: leaf.fingerprint,
    xrplScore: leaf.xrplScore,
    scoreStatus: leaf.scoreStatus,
    scoreObservationRef: leaf.scoreObservationRef,
    methodology: leaf.methodology,
    sanctions: s,
    loans,
    eventTypes: [...leaf.eventTypes].sort(),
    engineVersion: leaf.engineVersion,
    generatedAt: leaf.generatedAt,
  });
}

export function monitorLeafHash(leaf: MonitorLeaf): string {
  return leafHash(canonMonitorJson(leaf));
}

export const MONITOR_DISCLAIMER =
  "XRPLHub monitoring reports OBSERVED CHANGES in public XRP Ledger data for wallets you chose to watch, checked " +
  "about once a day. It is layered on top of your own underwriting and does not replace it: it cannot see borrower " +
  "credit, collateral, legal structure, or anything off the ledger. It gives no recommendation and no probability " +
  "of default; 'no change observed' does not mean 'safe'. XRPLScore is an informational analytics signal, not a " +
  "consumer report, and must not be used, alone or combined with other data, to make or communicate any decision " +
  "about a consumer's eligibility for credit, insurance, employment or housing (FCRA / ECOA).";

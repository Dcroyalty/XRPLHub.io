// src/lib/underwriteCanon.ts
// FROZEN canonicalisation for the lending-underwriting-inputs bundle —
// canonVersion "underwrite-bundle-v1".
//
// The bundle is FACTS ONLY: it commits to the exact exposure snapshot, the exact
// OFAC screening receipt, the XRPLScore, and the observation summary that
// XRPLHub returned for a borrower at a moment in time. It contains no
// recommendation — no principal, no rate, no approve/decline, no PD. The leaf
// commits to the COMPONENT leaf hashes so each part is also independently
// verifiable via its own queryId.
//
// Same leaf hash / Merkle scheme as every other XRPLHub anchor (./merkle).

import { createHash } from "crypto";

export const UNDERWRITE_CANON_VERSION = "underwrite-bundle-v1";

// Bump (v2, v3, …) in the same commit as any change to WHICH components the
// bundle includes or WHAT the leaf commits to. A change to a component engine
// (exposure, screening, score) is that component's own version bump, not this one.
export const UNDERWRITE_ENGINE_VERSION = "underwrite-bundle-v1";

export const UNDERWRITE_CANON_SPEC = {
  version: UNDERWRITE_CANON_VERSION,
  engine: {
    version: UNDERWRITE_ENGINE_VERSION,
    composes: [
      "exposure: src/lib/lendingExposure.ts runExposureQuery (canonVersion lending-exposure-v1)",
      "screening: src/lib/screen.ts OFAC SDN exact match (canonVersion ofac-screen-v1)",
      "score: src/lib/xrplscore.ts XRPLScore v1.1",
      "observation: LendingLoanObservation + sweepCoverage",
    ],
    factsOnly:
      "This attestation carries NO recommendation. It has no field for recommended principal, rate, rate floor, " +
      "approve/decline, probability of default, risk score, credit limit, or eligibility. Every value is an " +
      "on-ledger fact, XRPLHub's published XRPLScore (a factual signal sold standalone), or a factual list " +
      "comparison. The lending decision, and responsibility for it, is entirely the broker's.",
  },
  record: {
    description:
      "Build a JSON object with EXACTLY these keys in this order, then JSON.stringify with no extra whitespace.",
    keys: [
      "queryId", // UUIDv4
      "borrower", // the XRPL address
      "ledgerIndex", // validated ledger of the exposure walk
      "generatedAt", // RFC 3339 UTC, ms, 'Z'
      "exposureLeafHash", // the lending-exposure-v1 leaf hash (also independently verifiable)
      "exposureSummary", // { loanCount, brokerCount, events{defaulted,impaired,overdue,overdueGraceExpired}, worstStatus }
      "screeningLeafHash", // the ofac-screen-v1 leaf hash (also independently verifiable), or "" if screening unavailable
      "screeningListed", // boolean — did the address appear on the OFAC SDN snapshot
      "screeningVintage", // OFAC SDN publish date screened against, or ""
      "xrplScore", // integer 300-850, or null
      "observationSummary", // { everObservedLoans, totalLoansEverObserved, currentlyVisible, vanished, vanishedLastSeenDefaultedOrImpaired }
      "engineVersion", // "underwrite-bundle-v1"
    ],
  },
  leaves: "Order the receipts in a batch by queryId ascending. Leaf hash = SHA-256( 0x00 || utf8(recordJson) ).",
  merkle:
    "RFC 6962. Internal node = SHA-256( 0x01 || left || right ). Odd node promoted. Single-leaf root = leaf hash. Empty root = SHA-256('').",
  root: "Lowercase 64-char hex.",
  onLedger: {
    account: "r9dQS1oGms3B7SdY6nyU24Dy7dWyWXuJXb",
    transactionType: "AccountSet",
    memoType: `XRPLHub-Underwrite-Bundle-Anchor/${UNDERWRITE_CANON_VERSION}`,
    memoFormat: "application/json",
    memoDataIs: "hex(UTF-8 JSON) — { v, root, leaves, rangeStart, rangeEnd, ts }.",
  },
} as const;

export interface UnderwriteLeaf {
  queryId: string;
  borrower: string;
  ledgerIndex: number;
  generatedAt: string;
  exposureLeafHash: string;
  exposureSummary: {
    loanCount: number;
    brokerCount: number;
    events: { defaulted: number; impaired: number; overdue: number; overdueGraceExpired: number };
    worstStatus: string;
  };
  screeningLeafHash: string;
  screeningListed: boolean;
  screeningVintage: string;
  xrplScore: number | null;
  observationSummary: {
    everObservedLoans: boolean;
    totalLoansEverObserved: number;
    currentlyVisible: number;
    vanished: number;
    vanishedLastSeenDefaultedOrImpaired: number;
  };
  engineVersion: string;
}

export function canonUnderwriteLeaf(leaf: UnderwriteLeaf): string {
  return JSON.stringify({
    queryId: leaf.queryId,
    borrower: leaf.borrower,
    ledgerIndex: leaf.ledgerIndex,
    generatedAt: leaf.generatedAt,
    exposureLeafHash: leaf.exposureLeafHash,
    exposureSummary: {
      loanCount: leaf.exposureSummary.loanCount,
      brokerCount: leaf.exposureSummary.brokerCount,
      events: {
        defaulted: leaf.exposureSummary.events.defaulted,
        impaired: leaf.exposureSummary.events.impaired,
        overdue: leaf.exposureSummary.events.overdue,
        overdueGraceExpired: leaf.exposureSummary.events.overdueGraceExpired,
      },
      worstStatus: leaf.exposureSummary.worstStatus,
    },
    screeningLeafHash: leaf.screeningLeafHash,
    screeningListed: leaf.screeningListed,
    screeningVintage: leaf.screeningVintage,
    xrplScore: leaf.xrplScore,
    observationSummary: {
      everObservedLoans: leaf.observationSummary.everObservedLoans,
      totalLoansEverObserved: leaf.observationSummary.totalLoansEverObserved,
      currentlyVisible: leaf.observationSummary.currentlyVisible,
      vanished: leaf.observationSummary.vanished,
      vanishedLastSeenDefaultedOrImpaired: leaf.observationSummary.vanishedLastSeenDefaultedOrImpaired,
    },
    engineVersion: leaf.engineVersion,
  });
}

export function underwriteLeafHash(leaf: UnderwriteLeaf): string {
  return createHash("sha256")
    .update(Buffer.concat([Buffer.from([0x00]), Buffer.from(canonUnderwriteLeaf(leaf), "utf8")]))
    .digest("hex");
}

export const UNDERWRITE_DISCLAIMER =
  "These are inputs for your underwriting, not a recommendation. XRPLHub does not recommend a principal, " +
  "rate, or term, does not estimate probability of default, and does not approve or decline anyone. Every " +
  "field is an on-ledger fact, XRPLHub's published XRPLScore, or a factual OFAC SDN list comparison. The " +
  "lending decision, and responsibility for it, is entirely yours. Not lending, credit, or underwriting " +
  "advice. Exposure reflects the validated ledger now — XLS-66 keeps current exposure only, a defaulted " +
  "loan zeroes its own amounts, and paid/defaulted loans can be deleted, so absence is not proof of no " +
  "borrowing history. The OFAC screening is a factual comparison against a named list snapshot at a stated " +
  "time — a \"no match\" is not a statement that the address is clean or unsanctioned, and XRPLHub does not " +
  "perform any regulated screening function.";

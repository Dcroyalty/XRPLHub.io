// src/lib/underwriteBundle.ts
// GET /api/x402/lending/underwrite?borrower= — one call, every input a LoanBroker
// needs for an underwriting decision, as FACTS. No recommendation of any kind.
//
// Composes: runExposureQuery (cross-broker exposure + observation), screenOfac
// (OFAC SDN, with its own receipt), computeScore via the exposure query, and
// sweepCoverageFor (observation gaps). One bundle attestation ties the
// component leaf hashes together; each component is also independently
// verifiable via its own queryId.

import { randomUUID } from "crypto";
import type { PrismaClient } from "@prisma/client";
import { isValidXrplAddress } from "./engine";
import { runExposureQuery, sweepCoverageFor, type ExposureResult, type SweepCoverage } from "./lendingExposure";
import { screenOfac, NoSnapshotError, type ScreenOutcome } from "./screen";
import {
  UNDERWRITE_CANON_VERSION,
  UNDERWRITE_ENGINE_VERSION,
  UNDERWRITE_DISCLAIMER,
  underwriteLeafHash,
  type UnderwriteLeaf,
} from "./underwriteCanon";
import { LENDING_PROTOCOL_AMENDMENT_ID } from "./lendingLedger";
import { METHODOLOGY } from "./xrplscore";

export { isValidXrplAddress };

export interface UnderwriteBundleResult {
  queryId: string;
  borrower: string;
  amendmentActive: boolean;
  ledgerIndex: number;
  ledgerCloseAt: string | null;
  generatedAt: string;

  exposure: ExposureResult["exposure"] | null;
  events: ExposureResult["events"];
  worstStatus: string;
  earliestNextPaymentDue: string | null;

  score: { xrplScore: number | null; grade: string | null; methodology: string };

  screening:
    | {
        available: true;
        listed: boolean;
        list: { name: string; vintage: string; sha256: string };
        matches: Array<{ list: string; entryId: string; entryName: string; addressField: string }>;
        statement: string;
        receiptQueryId: string;
        receiptLeafHash: string;
      }
    | { available: false; reason: string };

  observationHistory: {
    everObservedLoans: boolean;
    firstObservedAt: string | null;
    totalLoansEverObserved: number;
    currentlyVisible: number;
    vanished: number;
    vanishedLastSeenDefaultedOrImpaired: number;
    sweepCoverage: SweepCoverage;
  };

  attestation: {
    queryId: string;
    canonVersion: string;
    engineVersion: string;
    leafHash: string;
    components: { exposureQueryId: string | null; screeningQueryId: string | null };
    verify: string;
    anchor: { status: "pending"; note: string };
  } | null;

  amendmentId: string;
  disclaimer: string;
}

export async function runUnderwriteBundle(
  prisma: PrismaClient,
  borrower: string,
  requestedBy: string
): Promise<UnderwriteBundleResult> {
  const queryId = randomUUID();
  const generatedAt = new Date().toISOString();

  // Exposure query — also computes the XRPLScore and updates the observation
  // tracker. Its own immutable snapshot is persisted (requestedBy "underwrite").
  const exposure = await runExposureQuery(prisma, borrower, requestedBy);

  // OFAC screening — works with or without XLS-66. Its own receipt is persisted.
  let screening: UnderwriteBundleResult["screening"];
  let screenOut: ScreenOutcome | null = null;
  try {
    screenOut = await screenOfac(prisma, borrower, requestedBy);
    const listed = screenOut.leaf.result.listed;
    screening = {
      available: true,
      listed,
      list: screenOut.leaf.lists[0],
      matches: listed ? screenOut.leaf.result.matches : [],
      statement: screenOut.statement,
      receiptQueryId: screenOut.queryId,
      receiptLeafHash: screenOut.leafHash,
    };
  } catch (e) {
    screening = {
      available: false,
      reason: e instanceof NoSnapshotError ? "OFAC SDN snapshot not yet ingested" : "screening failed",
    };
  }

  const sweepCoverage = await sweepCoverageFor(prisma, borrower);
  const obs = exposure.observation;

  const score = { xrplScore: exposure.xrplScore, grade: exposure.grade, methodology: METHODOLOGY };

  const observationHistory = {
    everObservedLoans: obs.everObservedLoans,
    firstObservedAt: obs.firstObservedAt,
    totalLoansEverObserved: obs.totalLoansEverObserved,
    currentlyVisible: obs.currentlyVisible,
    vanished: obs.vanished,
    vanishedLastSeenDefaultedOrImpaired: obs.vanishedLastSeenDefaultedOrImpaired,
    sweepCoverage,
  };

  const baseResult = {
    queryId,
    borrower,
    ledgerIndex: exposure.ledgerIndex,
    ledgerCloseAt: exposure.ledgerCloseAt,
    generatedAt,
    events: exposure.events,
    worstStatus: exposure.worstStatus,
    earliestNextPaymentDue: exposure.earliestNextPaymentDue,
    score,
    screening,
    observationHistory,
    amendmentId: LENDING_PROTOCOL_AMENDMENT_ID,
    disclaimer: UNDERWRITE_DISCLAIMER,
  };

  if (!exposure.amendmentActive) {
    // Score + OFAC still returned; no exposure, no bundle receipt.
    return {
      ...baseResult,
      amendmentActive: false,
      exposure: null,
      attestation: null,
    };
  }

  // ── Bundle leaf + persist ────────────────────────────────────────────────
  const leaf: UnderwriteLeaf = {
    queryId,
    borrower,
    ledgerIndex: exposure.ledgerIndex,
    generatedAt,
    exposureLeafHash: exposure.leafHash,
    exposureSummary: {
      loanCount: exposure.exposure.loanCount,
      brokerCount: exposure.exposure.brokerCount,
      events: exposure.events,
      worstStatus: exposure.worstStatus,
    },
    screeningLeafHash: screenOut?.leafHash ?? "",
    screeningListed: screenOut ? screenOut.leaf.result.listed : false,
    screeningVintage: screenOut?.leaf.lists[0]?.vintage ?? "",
    xrplScore: exposure.xrplScore,
    observationSummary: {
      everObservedLoans: obs.everObservedLoans,
      totalLoansEverObserved: obs.totalLoansEverObserved,
      currentlyVisible: obs.currentlyVisible,
      vanished: obs.vanished,
      vanishedLastSeenDefaultedOrImpaired: obs.vanishedLastSeenDefaultedOrImpaired,
    },
    engineVersion: UNDERWRITE_ENGINE_VERSION,
  };
  const leafHash = underwriteLeafHash(leaf);

  await prisma.underwriteBundleReceipt.create({
    data: {
      queryId,
      borrower,
      ledgerIndex: exposure.ledgerIndex,
      requestedBy,
      exposureQueryId: exposure.queryId,
      screeningQueryId: screenOut?.queryId ?? null,
      xrplScore: exposure.xrplScore,
      screeningListed: leaf.screeningListed,
      worstStatus: exposure.worstStatus,
      leafJson: leaf as unknown as object,
      leafHash,
      canonVersion: UNDERWRITE_CANON_VERSION,
      engineVersion: UNDERWRITE_ENGINE_VERSION,
    },
  });

  return {
    ...baseResult,
    amendmentActive: true,
    exposure: exposure.exposure,
    attestation: {
      queryId,
      canonVersion: UNDERWRITE_CANON_VERSION,
      engineVersion: UNDERWRITE_ENGINE_VERSION,
      leafHash,
      components: { exposureQueryId: exposure.queryId, screeningQueryId: screenOut?.queryId ?? null },
      verify: `https://www.xrplhub.io/api/attest/verify?queryId=${queryId}`,
      anchor: { status: "pending", note: "Recorded now; included in the next daily Merkle anchor." },
    },
  };
}

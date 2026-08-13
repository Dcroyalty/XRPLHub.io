// src/lib/engine.ts
// WIRED to your existing scorer. computeScore() now runs the exact same
// pipeline your website uses, so the API and the site can never return
// different numbers for the same wallet:
//
//   address -> buildAccountSnapshot()  (src/lib/xrpl-client.ts)
//           -> calculateLedgerScore()  (src/lib/ledger-score.ts)
//           -> { total, tier, components, positives, negatives, tips }
//
// We surface that as a clean B2B response below.

import { buildAccountSnapshot } from "@/lib/xrpl-client";
import { calculateLedgerScore } from "@/lib/ledger-score";

export interface ScoreResult {
  wallet: string;        // the address that was scored
  score: number;         // 300–850 (your ScoreBreakdown.total)
  tier: string;          // POOR | FAIR | GOOD | VERY_GOOD | EXCELLENT
  signals: {             // your 5 component scores, 0–100 each
    accountAge: number;
    txVolumeVariety: number;
    ammDefi: number;
    trustLinesRlusd: number;
    accountHealth: number;
  };
  insights: {            // your human-readable output
    positives: string[];
    negatives: string[];
    tips: string[];
  };
  computedAt: string;    // ISO timestamp
}

/**
 * Score a single XRPL wallet using your production scoring engine.
 * Throws if the wallet can't be fetched (e.g. account not found) — the API
 * route turns that into a clean error response.
 */
export async function computeScore(wallet: string): Promise<ScoreResult> {
  const snapshot = await buildAccountSnapshot(wallet);
  const b = calculateLedgerScore(snapshot);

  return {
    wallet,
    score: b.total,
    tier: b.tier,
    signals: {
      accountAge: b.components.accountAge.raw,
      txVolumeVariety: b.components.txVolumeVariety.raw,
      ammDefi: b.components.ammDefi.raw,
      trustLinesRlusd: b.components.trustLinesRlusd.raw,
      accountHealth: b.components.accountHealth.raw,
    },
    insights: {
      positives: b.positives,
      negatives: b.negatives,
      tips: b.tips,
    },
    computedAt: new Date().toISOString(),
  };
}

/** Cheap sanity check so bad input fails at the door, not deep in scoring. */
export function isValidXrplAddress(addr: string): boolean {
  return /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(addr);
}

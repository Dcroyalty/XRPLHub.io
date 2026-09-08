// src/lib/scoreCache.ts
// ─────────────────────────────────────────────────────────────────────────────
// The 15-minute DISPLAY cache for XRPLScore.
//
//   ┌───────────────────────────────────────────────────────────────────────┐
//   │  NEVER CALL getScoreCached() FROM AN ATTESTATION PATH.                 │
//   │                                                                       │
//   │  Screening, lending exposure, the underwrite bundle and credential    │
//   │  issuance anchor `xrplScore` inside a Merkle leaf / sign it into a     │
//   │  credential. A 15-minute-old number anchored on-chain as "current" is  │
//   │  the degradation bug in a different coat.                              │
//   │                                                                       │
//   │  Those paths call scoreWallet() (src/lib/xrplscore.ts) DIRECTLY.       │
//   │  scripts/check-attestation-freshness.mjs fails the build if this file  │
//   │  is imported anywhere under the attestation modules.                   │
//   └───────────────────────────────────────────────────────────────────────┘
//
// Only the FREE display surfaces use this: GET /api/score/[address] and
// GET /api/v1/score (with the caller's own plan TTL). Paid per-call x402 score
// / report stay fresh.

import type { PrismaClient } from "@prisma/client";
import { scoreWallet, type XrplScoreResult } from "./xrplscore";
import { bumpXrpl, forceFlushXrplCounters } from "./xrplCounters";

export const SCORE_CACHE_TTL_MS = 15 * 60 * 1000;

export interface CachedScore {
  result: XrplScoreResult;
  computedAt: string; // ISO — when this result's RPC data was actually fetched
  fromCache: boolean;
  ageMs: number;
}

/**
 * Score for display. Serves a stored result up to `maxAgeMs` old; on a miss
 * (or maxAgeMs <= 0) computes fresh via scoreWallet() and stores it.
 * Propagates AccountNotFoundError / XrplUnavailableError from scoreWallet.
 */
export async function getScoreCached(
  prisma: PrismaClient,
  address: string,
  maxAgeMs: number = SCORE_CACHE_TTL_MS
): Promise<CachedScore> {
  if (maxAgeMs > 0) {
    const row = await prisma.ledgerScore.findUnique({ where: { address } }).catch(() => null);
    if (row?.resultJson && row.scoredAt) {
      const ageMs = Date.now() - row.scoredAt.getTime();
      if (ageMs < maxAgeMs) {
        try {
          const result = JSON.parse(row.resultJson) as XrplScoreResult;
          bumpXrpl("cache:hit");
          forceFlushXrplCounters(prisma);
          return { result, computedAt: row.scoredAt.toISOString(), fromCache: true, ageMs };
        } catch {
          /* corrupt JSON — fall through and recompute */
        }
      }
    }
  }

  bumpXrpl("cache:miss");
  const result = await scoreWallet(address);
  const scoredAt = new Date();

  await prisma.ledgerScore
    .upsert({
      where: { address },
      update: {
        score: result.ledgerScore,
        tier: result.grade,
        breakdown: JSON.stringify(result.signals),
        rawData: JSON.stringify(result.details),
        resultJson: JSON.stringify(result),
        scoredAt,
      },
      create: {
        address,
        score: result.ledgerScore,
        tier: result.grade,
        breakdown: JSON.stringify(result.signals),
        rawData: JSON.stringify(result.details),
        resultJson: JSON.stringify(result),
        scoredAt,
      },
    })
    .catch(() => {});

  forceFlushXrplCounters(prisma);
  return { result, computedAt: scoredAt.toISOString(), fromCache: false, ageMs: 0 };
}

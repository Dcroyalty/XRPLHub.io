// src/lib/report.ts
// Full Wallet Risk Report — the premium bot product.
// Everything the score returns, PLUS machine-readable risk flags and the
// on-chain snapshot the score was built from.
//
// Runs on the ONE engine (src/lib/xrplscore.ts) via computeScore(), so the
// report's score is identical to the site's and the plain /api/v1/score.

import { computeScore, type ScoreResult } from "@/lib/engine";
import { scoreWallet } from "@/lib/xrplscore";

export interface WalletReport {
  score: ScoreResult;
  riskFlags: string[];
  weightedSignals: Array<{
    key: string;
    label: string;
    score: number;   // 0–100
    weight: string;  // e.g. "20%"
    desc: string;
  }>;
  snapshot: {
    xrpBalance: number;
    trustLineCount: number;
    hasRlusdTrustLine: boolean;
    ammTxCount: number;
    dexTxCount: number;
    nftCount: number;
    txCount: number;
    accountAgeDays: number;
    reserveXRP: number;
  };
  generatedAt: string;
}

export async function buildWalletReport(wallet: string): Promise<WalletReport> {
  const raw = await scoreWallet(wallet);

  // Reshape into the B2B ScoreResult (same numbers, no second network call).
  const score: ScoreResult = {
    wallet: raw.address,
    score: raw.ledgerScore,
    grade: raw.grade,
    tier: raw.grade,
    percentile: raw.percentile,
    signals: raw.signals as ScoreResult["signals"],
    breakdown: raw.breakdown,
    recommendations: raw.recommendations,
    details: raw.details,
    methodology: raw.methodology,
    computedAt: new Date().toISOString(),
  };

  const d = raw.details;

  const riskFlags: string[] = [];
  if (raw.ledgerScore < 500) riskFlags.push("LOW_SCORE");
  if (raw.ledgerScore < 400) riskFlags.push("VERY_LOW_SCORE");
  if (!raw.hasRlusdTrustLine) riskFlags.push("NO_RLUSD_TRUSTLINE");
  if (d.balanceXRP < 2) riskFlags.push("LOW_XRP_RESERVE_RISK");
  if (d.txCount < 10) riskFlags.push("LOW_ACTIVITY");
  if (d.trustLineCount === 0) riskFlags.push("NO_TRUSTLINES");
  if (!d.hasMultiSig && !d.hasRegKey) riskFlags.push("NO_ACCOUNT_SECURITY");

  return {
    score,
    riskFlags,
    weightedSignals: raw.breakdown.map((b) => ({
      key: b.signal,
      label: b.label,
      score: b.score,
      weight: b.weight,
      desc: b.desc,
    })),
    snapshot: {
      xrpBalance: d.balanceXRP,
      trustLineCount: d.trustLineCount,
      hasRlusdTrustLine: raw.hasRlusdTrustLine,
      ammTxCount: d.ammTxCount,
      dexTxCount: d.dexTxCount,
      nftCount: d.nftCount,
      txCount: d.txCount,
      accountAgeDays: d.accountAgeDays,
      reserveXRP: d.reserveXRP,
    },
    generatedAt: new Date().toISOString(),
  };
}

// computeScore is re-exported for callers that only want the score half.
export { computeScore };

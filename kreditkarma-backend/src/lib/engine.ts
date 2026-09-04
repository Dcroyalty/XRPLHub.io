// src/lib/engine.ts
// B2B surface over the ONE scoring engine (src/lib/xrplscore.ts). computeScore()
// runs the exact same pipeline the public site runs — same mainnet nodes, same
// 8 signals, same weights, same 300–850 math — so /api/v1/score, /api/x402/score
// and /api/score/<addr> can never return different numbers for the same wallet
// at the same ledger state.

import {
  scoreWallet,
  isValidXrplAddress,
  type ScoreBreakdownRow,
  type ScoreRecommendation,
  type XrplScoreDetails,
} from "@/lib/xrplscore";

export { isValidXrplAddress };
export { AccountNotFoundError } from "@/lib/xrplscore";

export interface ScoreResult {
  wallet: string;          // the address that was scored
  score: number;           // 300–850  (=== the site's ledgerScore)
  grade: string;           // Building | Fair | Good | Excellent | Exceptional
  tier: string;            // alias of grade (kept so older integrations don't break)
  percentile: number;      // peer percentile band
  signals: {               // the 8 component scores, 0–100 each (v1.1)
    accountAge: number;
    txActivity: number;
    financialHealth: number;
    tokenEngagement: number;
    dexActivity: number;
    ammActivity: number;
    securityConfig: number;
    nftActivity: number;
  };
  breakdown: ScoreBreakdownRow[];
  recommendations: ScoreRecommendation[];
  details: XrplScoreDetails;
  methodology: string;
  computedAt: string;      // ISO timestamp
}

/**
 * Score a single XRPL wallet using the production scoring engine.
 * Throws AccountNotFoundError if the address is not an activated mainnet
 * account; the API route turns that into a clean 404.
 */
export async function computeScore(wallet: string): Promise<ScoreResult> {
  const r = await scoreWallet(wallet);
  return {
    wallet: r.address,
    score: r.ledgerScore,
    grade: r.grade,
    tier: r.grade,
    percentile: r.percentile,
    signals: r.signals as ScoreResult["signals"],
    breakdown: r.breakdown,
    recommendations: r.recommendations,
    details: r.details,
    methodology: r.methodology,
    computedAt: new Date().toISOString(),
  };
}

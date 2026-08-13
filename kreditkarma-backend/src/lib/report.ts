// src/lib/report.ts
// Full Wallet Risk Report — the premium bot product ($0.25/call).
// Everything the 5¢ score returns, PLUS the raw on-chain snapshot the score
// was built from: balances, trust lines, tx activity, AMM positions, and
// weighted signal detail. One JSON response, no signing, no account.
//
// Reuses the proven pipeline: buildAccountSnapshot() + calculateLedgerScore().

import { buildAccountSnapshot } from "@/lib/xrpl-client";
import { calculateLedgerScore } from "@/lib/ledger-score";
import { computeScore, type ScoreResult } from "@/lib/engine";

export interface WalletReport {
  score: ScoreResult;            // the same score object the 5¢ call returns
  riskFlags: string[];           // quick machine-readable risk signals
  weightedSignals: Array<{       // per-signal detail incl. weight + label
    key: string;
    label: string;
    raw: number;
    weight: number;
    weighted: number;
    notes: string[];
  }>;
  snapshot: {                    // the raw on-chain facts, for a bot to reason on
    xrpBalance: number | null;
    trustLineCount: number | null;
    hasRlusdTrustLine: boolean;
    ammPositionCount: number | null;
    txCount: number | null;
  };
  generatedAt: string;
}

const RLUSD_HEX = "524C555344000000000000000000000000000000";

export async function buildWalletReport(wallet: string): Promise<WalletReport> {
  // Run the same two calls the score uses, but keep the snapshot too.
  const snap = await buildAccountSnapshot(wallet);
  const breakdown = calculateLedgerScore(snap);
  const score = await computeScore(wallet); // clean score object (same numbers)

  // Flatten the weighted component detail for machine consumption.
  const c = breakdown.components as Record<string, {
    raw: number; weight: number; weighted: number; label: string; notes: string[];
  }>;
  const weightedSignals = Object.entries(c).map(([key, v]) => ({
    key,
    label: v.label,
    raw: v.raw,
    weight: v.weight,
    weighted: v.weighted,
    notes: v.notes ?? [],
  }));

  // Machine-readable risk flags (concise; distinct from human "insights").
  const riskFlags: string[] = [];
  if (breakdown.total < 500) riskFlags.push("LOW_SCORE");
  if (breakdown.total < 400) riskFlags.push("VERY_LOW_SCORE");

  const s = snap as unknown as {
    xrpBalance?: number;
    trustLines?: Array<{ currency?: string }>;
    ammPositions?: unknown[];
    transactions?: unknown[];
  };
  const trustLines = Array.isArray(s.trustLines) ? s.trustLines : null;
  const hasRlusd = !!trustLines?.some(
    (t) => t.currency === RLUSD_HEX || t.currency === "RLUSD"
  );
  if (!hasRlusd) riskFlags.push("NO_RLUSD_TRUSTLINE");

  const xrpBalance = typeof s.xrpBalance === "number" ? s.xrpBalance : null;
  if (xrpBalance !== null && xrpBalance < 2) riskFlags.push("LOW_XRP_RESERVE_RISK");

  return {
    score,
    riskFlags,
    weightedSignals,
    snapshot: {
      xrpBalance,
      trustLineCount: trustLines ? trustLines.length : null,
      hasRlusdTrustLine: hasRlusd,
      ammPositionCount: Array.isArray(s.ammPositions) ? s.ammPositions.length : null,
      txCount: Array.isArray(s.transactions) ? s.transactions.length : null,
    },
    generatedAt: new Date().toISOString(),
  };
}

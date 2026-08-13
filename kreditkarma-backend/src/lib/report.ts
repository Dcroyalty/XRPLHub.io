// src/lib/report.ts
// Full Wallet Risk Report — the premium bot product ($0.25/call).
// Everything the 5¢ score returns, PLUS the raw on-chain snapshot the score
// was built from: balances, trust lines, tx activity, AMM positions, and
// weighted signal detail. One JSON response, no signing, no account.
//
// Reuses the proven pipeline: buildAccountSnapshot() + calculateLedgerScore().
// Field names below match the real AccountSnapshot interface in xrpl-client.ts
// (balanceXRP, txCount, ammPositions, trustLines).

import { buildAccountSnapshot } from "@/lib/xrpl-client";
import { calculateLedgerScore } from "@/lib/ledger-score";
import { computeScore, type ScoreResult } from "@/lib/engine";

export interface WalletReport {
  score: ScoreResult;
  riskFlags: string[];
  weightedSignals: Array<{
    key: string;
    label: string;
    raw: number;
    weight: number;
    weighted: number;
    notes: string[];
  }>;
  snapshot: {
    xrpBalance: number | null;
    trustLineCount: number | null;
    hasRlusdTrustLine: boolean;
    ammPositionCount: number | null;
    txCount: number | null;
    paymentCount: number | null;
    uniqueCounterparties: number | null;
    accountAgeSeconds: number | null;
  };
  generatedAt: string;
}

const RLUSD_HEX = "524C555344000000000000000000000000000000";

export async function buildWalletReport(wallet: string): Promise<WalletReport> {
  const snap = await buildAccountSnapshot(wallet);
  const breakdown = calculateLedgerScore(snap);
  const score = await computeScore(wallet);

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

  // Real snapshot fields (see AccountSnapshot interface).
  const s = snap as unknown as {
    balanceXRP?: number;
    txCount?: number;
    paymentCount?: number;
    uniqueCounterparties?: number;
    accountAge?: number;
    trustLines?: Array<{ currency?: string }>;
    ammPositions?: unknown[];
  };

  const trustLines = Array.isArray(s.trustLines) ? s.trustLines : null;
  const hasRlusd = !!trustLines?.some(
    (t) => t.currency === RLUSD_HEX || t.currency === "RLUSD"
  );
  const xrpBalance = typeof s.balanceXRP === "number" ? s.balanceXRP : null;

  // Machine-readable risk flags.
  const riskFlags: string[] = [];
  if (breakdown.total < 500) riskFlags.push("LOW_SCORE");
  if (breakdown.total < 400) riskFlags.push("VERY_LOW_SCORE");
  if (!hasRlusd) riskFlags.push("NO_RLUSD_TRUSTLINE");
  if (xrpBalance !== null && xrpBalance < 2) riskFlags.push("LOW_XRP_RESERVE_RISK");
  if ((s.txCount ?? 0) < 10) riskFlags.push("LOW_ACTIVITY");
  if ((s.uniqueCounterparties ?? 0) < 3) riskFlags.push("FEW_COUNTERPARTIES");

  return {
    score,
    riskFlags,
    weightedSignals,
    snapshot: {
      xrpBalance,
      trustLineCount: trustLines ? trustLines.length : null,
      hasRlusdTrustLine: hasRlusd,
      ammPositionCount: Array.isArray(s.ammPositions) ? s.ammPositions.length : null,
      txCount: typeof s.txCount === "number" ? s.txCount : null,
      paymentCount: typeof s.paymentCount === "number" ? s.paymentCount : null,
      uniqueCounterparties:
        typeof s.uniqueCounterparties === "number" ? s.uniqueCounterparties : null,
      accountAgeSeconds: typeof s.accountAge === "number" ? s.accountAge : null,
    },
    generatedAt: new Date().toISOString(),
  };
}

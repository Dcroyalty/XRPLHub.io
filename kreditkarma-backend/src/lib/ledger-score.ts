// src/lib/ledger-score.ts
// ─────────────────────────────────────────────────────────────────────────────
// LEDGERSCORE — Deterministic on-chain credit score (300–850)
//
// Inspired by FICO methodology, adapted for XRPL on-chain data.
//
// SCORE COMPONENTS (total = 850 max, floor = 300)
// ┌──────────────────────────────┬────────┬────────────────────────────────┐
// │ Component                    │ Weight │ Signals                        │
// ├──────────────────────────────┼────────┼────────────────────────────────┤
// │ Account Age & History        │  25%   │ Ledger age, tx count           │
// │ Transaction Volume & Variety │  25%   │ 30d volume, unique counterparts│
// │ AMM / DeFi Participation     │  20%   │ LP positions, AMM tx count     │
// │ Trust Lines & RLUSD Use      │  15%   │ RLUSD balance, active lines    │
// │ Account Health & Security    │  15%   │ Balance, owner count, sig list │
// └──────────────────────────────┴────────┴────────────────────────────────┘
// ─────────────────────────────────────────────────────────────────────────────

import type { AccountSnapshot } from "./xrpl-client";

export type ScoreTier = "POOR" | "FAIR" | "GOOD" | "VERY_GOOD" | "EXCELLENT";

export interface ScoreBreakdown {
  total: number;
  tier: ScoreTier;

  // Component scores (0–100 each, before weighting)
  components: {
    accountAge: ComponentDetail;
    txVolumeVariety: ComponentDetail;
    ammDefi: ComponentDetail;
    trustLinesRlusd: ComponentDetail;
    accountHealth: ComponentDetail;
  };

  // Human-readable insights
  positives: string[];
  negatives: string[];
  tips: string[];
}

interface ComponentDetail {
  raw: number;      // 0–100
  weighted: number; // raw × weight
  weight: number;
  label: string;
  notes: string[];
}

const WEIGHTS = {
  accountAge: 0.25,
  txVolumeVariety: 0.25,
  ammDefi: 0.20,
  trustLinesRlusd: 0.15,
  accountHealth: 0.15,
};

const SCORE_MIN = 300;
const SCORE_MAX = 850;

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

export function calculateLedgerScore(snap: AccountSnapshot): ScoreBreakdown {
  const age = scoreAccountAge(snap);
  const volume = scoreTxVolumeVariety(snap);
  const amm = scoreAmmDefi(snap);
  const trust = scoreTrustLinesRlusd(snap);
  const health = scoreAccountHealth(snap);

  // Weighted sum (0–100 range)
  const rawScore =
    age.raw * WEIGHTS.accountAge +
    volume.raw * WEIGHTS.txVolumeVariety +
    amm.raw * WEIGHTS.ammDefi +
    trust.raw * WEIGHTS.trustLinesRlusd +
    health.raw * WEIGHTS.accountHealth;

  // Map 0–100 → 300–850
  const total = Math.round(SCORE_MIN + (rawScore / 100) * (SCORE_MAX - SCORE_MIN));

  const components = {
    accountAge: { ...age, weight: WEIGHTS.accountAge, weighted: age.raw * WEIGHTS.accountAge },
    txVolumeVariety: { ...volume, weight: WEIGHTS.txVolumeVariety, weighted: volume.raw * WEIGHTS.txVolumeVariety },
    ammDefi: { ...amm, weight: WEIGHTS.ammDefi, weighted: amm.raw * WEIGHTS.ammDefi },
    trustLinesRlusd: { ...trust, weight: WEIGHTS.trustLinesRlusd, weighted: trust.raw * WEIGHTS.trustLinesRlusd },
    accountHealth: { ...health, weight: WEIGHTS.accountHealth, weighted: health.raw * WEIGHTS.accountHealth },
  };

  const { positives, negatives, tips } = buildInsights(snap, components);

  return {
    total,
    tier: getTier(total),
    components,
    positives,
    negatives,
    tips,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Component scorers
// ─────────────────────────────────────────────────────────────────────────────

function scoreAccountAge(snap: AccountSnapshot): Omit<ComponentDetail, "weight" | "weighted"> {
  const notes: string[] = [];
  let raw = 0;

  // Age score: max at ~2 years (63M seconds)
  if (snap.accountAge != null) {
    const ageYears = snap.accountAge / (365 * 24 * 3600);
    const ageScore = Math.min(50, (ageYears / 2) * 50); // 0–50 pts
    raw += ageScore;
    notes.push(`Account age ~${(ageYears).toFixed(1)} years (+${ageScore.toFixed(0)} pts)`);
  } else {
    notes.push("Account age unknown (no transactions found)");
  }

  // Transaction count score: max at 500 tx
  const txScore = Math.min(50, (snap.txCount / 500) * 50);
  raw += txScore;
  notes.push(`${snap.txCount} lifetime transactions (+${txScore.toFixed(0)} pts)`);

  return { raw: Math.min(raw, 100), label: "Account Age & History", notes };
}

function scoreTxVolumeVariety(snap: AccountSnapshot): Omit<ComponentDetail, "weight" | "weighted"> {
  const notes: string[] = [];
  let raw = 0;

  // 30-day volume (max at 10,000 XRP)
  const volScore = Math.min(40, (snap.recentVolume30d / 10_000) * 40);
  raw += volScore;
  notes.push(`30d volume: ${snap.recentVolume30d.toFixed(1)} XRP (+${volScore.toFixed(0)} pts)`);

  // Unique counterparties (max at 50)
  const cpScore = Math.min(30, (snap.uniqueCounterparties / 50) * 30);
  raw += cpScore;
  notes.push(`${snap.uniqueCounterparties} unique counterparties (+${cpScore.toFixed(0)} pts)`);

  // Offer/DEX usage (max at 100 offers)
  const dexScore = Math.min(15, (snap.offerCount / 100) * 15);
  raw += dexScore;
  if (snap.offerCount > 0) notes.push(`${snap.offerCount} DEX offers placed (+${dexScore.toFixed(0)} pts)`);

  // Received payments (network trust signal, max at 100)
  const recvScore = Math.min(15, (snap.receivedPayments / 100) * 15);
  raw += recvScore;
  notes.push(`${snap.receivedPayments} received payments (+${recvScore.toFixed(0)} pts)`);

  return { raw: Math.min(raw, 100), label: "Transaction Volume & Variety", notes };
}

function scoreAmmDefi(snap: AccountSnapshot): Omit<ComponentDetail, "weight" | "weighted"> {
  const notes: string[] = [];
  let raw = 0;

  const ammPositions = snap.ammPositions.length;

  if (ammPositions === 0) {
    notes.push("No AMM LP positions detected (major opportunity)");
    // Partial credit if they have DEX offer history (manual market making)
    if (snap.offerCount > 20) {
      raw += 20;
      notes.push(`Active DEX trader (${snap.offerCount} offers) — partial DeFi credit (+20 pts)`);
    }
  } else {
    // 1 position = 40pts, 2 = 60pts, 3+ = 80pts
    const posScore = Math.min(80, ammPositions * 30 + 10);
    raw += posScore;
    notes.push(`${ammPositions} active AMM LP position(s) (+${posScore} pts)`);
  }

  // Bonus: RLUSD-related AMM positions (extra 20pts)
  const hasRlusdAmm = snap.ammPositions.some(
    (p) => p.asset1.includes("RLUSD") || p.asset2.includes("RLUSD")
  );
  if (hasRlusdAmm) {
    raw += 20;
    notes.push("RLUSD AMM participation detected (+20 pts)");
  }

  return { raw: Math.min(raw, 100), label: "AMM / DeFi Participation", notes };
}

function scoreTrustLinesRlusd(snap: AccountSnapshot): Omit<ComponentDetail, "weight" | "weighted"> {
  const notes: string[] = [];
  let raw = 0;

  const rlusdLine = snap.trustLines.find(
    (t) =>
      t.currency === "RLUSD" ||
      t.currency === "524C555344000000000000000000000000000000"
  );

  if (rlusdLine) {
    const balance = parseFloat(rlusdLine.balance);
    raw += 40;
    notes.push(`RLUSD trust line established (+40 pts)`);

    // Balance score (max at $500 RLUSD)
    const balScore = Math.min(30, (balance / 500) * 30);
    raw += balScore;
    if (balance > 0)
      notes.push(`RLUSD balance: $${balance.toFixed(2)} (+${balScore.toFixed(0)} pts)`);
  } else {
    notes.push("No RLUSD trust line (set one up for a big score boost)");
  }

  // Other stablecoin trust lines (USD, BTC, ETH IOUs)
  const stableCoins = ["USD", "BTC", "ETH", "SOLO", "CSC"];
  const otherLines = snap.trustLines.filter(
    (t) => stableCoins.includes(t.currency) && parseFloat(t.balance) > 0
  );
  const otherScore = Math.min(30, otherLines.length * 10);
  raw += otherScore;
  if (otherLines.length)
    notes.push(`${otherLines.length} other active trust line(s) (+${otherScore} pts)`);

  return { raw: Math.min(raw, 100), label: "Trust Lines & RLUSD", notes };
}

function scoreAccountHealth(snap: AccountSnapshot): Omit<ComponentDetail, "weight" | "weighted"> {
  const notes: string[] = [];
  let raw = 0;

  // XRP balance (max at 1000 XRP = 40pts)
  const balScore = Math.min(40, (snap.balanceXRP / 1000) * 40);
  raw += balScore;
  notes.push(`Balance: ${snap.balanceXRP.toFixed(2)} XRP (+${balScore.toFixed(0)} pts)`);

  // Signer list (multi-sig = security signal, +20pts)
  if (snap.signerListSet) {
    raw += 20;
    notes.push("Multi-sig signer list configured (+20 pts)");
  }

  // Regular key set (+10pts — shows account management)
  if (snap.regularKeySet) {
    raw += 10;
    notes.push("Regular key set (+10 pts)");
  }

  // Owner count — too many objects is slightly negative (escrows, offers, etc.)
  if (snap.ownerCount <= 5) {
    raw += 15;
    notes.push(`Clean account (${snap.ownerCount} objects) (+15 pts)`);
  } else if (snap.ownerCount <= 20) {
    raw += 10;
    notes.push(`Moderate account objects: ${snap.ownerCount} (+10 pts)`);
  } else {
    raw += 5;
    notes.push(`High object count: ${snap.ownerCount} — reserve cost noted (+5 pts)`);
  }

  // Minimum balance check (must be above spam threshold)
  if (snap.balanceXRP < 1) {
    raw = Math.max(0, raw - 20);
    notes.push("Balance below reserve minimum (−20 pts)");
  }

  // Sequence number (high = old account bonus)
  if (snap.sequence > 1000) {
    raw += 15;
    notes.push(`High sequence # (${snap.sequence}) — long-standing account (+15 pts)`);
  }

  return { raw: Math.min(raw, 100), label: "Account Health & Security", notes };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

export function getTier(score: number): ScoreTier {
  if (score < 580) return "POOR";
  if (score < 670) return "FAIR";
  if (score < 740) return "GOOD";
  if (score < 800) return "VERY_GOOD";
  return "EXCELLENT";
}

function buildInsights(
  snap: AccountSnapshot,
  components: ScoreBreakdown["components"]
): Pick<ScoreBreakdown, "positives" | "negatives" | "tips"> {
  const positives: string[] = [];
  const negatives: string[] = [];
  const tips: string[] = [];

  if (snap.ammPositions.length > 0)
    positives.push(`Active AMM liquidity provider (${snap.ammPositions.length} pool(s))`);
  if (snap.txCount > 100)
    positives.push(`Strong transaction history (${snap.txCount} transactions)`);
  if (snap.uniqueCounterparties > 20)
    positives.push("Broad network activity across many counterparties");
  if (snap.signerListSet)
    positives.push("Account secured with multi-signature setup");
  if (snap.balanceXRP > 100)
    positives.push("Healthy XRP reserve balance");

  if (snap.ammPositions.length === 0)
    negatives.push("No AMM LP participation detected");
  if (snap.recentVolume30d < 10)
    negatives.push("Low transaction volume in the past 30 days");
  if (!snap.trustLines.some((t) => t.currency === "RLUSD" || t.currency === "524C555344000000000000000000000000000000"))
    negatives.push("No RLUSD trust line established");
  if (snap.balanceXRP < 10)
    negatives.push("XRP balance is low — risk of dropped reserve");

  if (snap.ammPositions.length === 0)
    tips.push("Add liquidity to an XRPL AMM pool to boost your DeFi score by up to 160 points");
  if (!snap.trustLines.some((t) => t.currency === "RLUSD" || t.currency === "524C555344000000000000000000000000000000"))
    tips.push("Set up an RLUSD trust line — it's free and adds up to 70 points");
  if (snap.recentVolume30d < 100)
    tips.push("Increase on-chain activity this month to improve your volume score");
  if (!snap.signerListSet)
    tips.push("Configure multi-sig on your account for a security bonus");

  return { positives, negatives, tips };
}

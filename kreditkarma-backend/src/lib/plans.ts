// src/lib/plans.ts
// SINGLE SOURCE OF TRUTH for pricing.
// The pricing page renders from this. guard.ts enforces from this. The
// checkout charges from this. Change a number here and the advertised
// price, the enforced quota, and the amount charged all move together.
//
// Priced Aug 2026 to undercut on-chain wallet-scoring competitors
// (Cred Protocol Pro ≈ 25k–50k score lookups/mo; traditional credit APIs
// $2.90–$3.99 per report). Our per-check cost is near zero, so these hold.

export type PlanId = "free" | "starter" | "growth" | "scale";

export interface Plan {
  id: PlanId;
  name: string;
  priceRlusd: number;      // charged per month via RLUSD checkout (0 = free)
  monthlyQuota: number;    // scored API calls included per calendar month
  rateLimitPerMin: number; // hard per-minute ceiling
  overage: boolean;        // ALWAYS false today: there is no overage billing anywhere, so every plan is a HARD monthly
                           // quota (429 at quota). Do not set true until something actually invoices the overage.
  overageRlusdPer1k: number; // reserved; 0 while overage billing does not exist
  cacheTtlSeconds: number; // score cache lifetime for this tier
  watchSlots: number;      // wallets one key may keep under continuous monitoring (/api/monitor)
  blurb: string;
  features: string[];
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    priceRlusd: 0,
    monthlyQuota: 200,
    rateLimitPerMin: 10,
    overage: false,
    overageRlusdPer1k: 0,
    cacheTtlSeconds: 300,
    watchSlots: 3,
    blurb: "Score real wallets, no card. Claim a key by connecting Xaman.",
    features: [
      "3 monitored wallets (daily change alerts by webhook)",
      "200 scored calls / month",
      "10 requests / minute",
      "300–850 score + full signal breakdown",
      "Connect Xaman to claim — no signup, no payment",
    ],
  },
  starter: {
    id: "starter",
    name: "Starter",
    priceRlusd: 29,
    monthlyQuota: 10_000,
    rateLimitPerMin: 60,
    overage: false,
    overageRlusdPer1k: 0,
    cacheTtlSeconds: 180,
    watchSlots: 25,
    blurb: "~$0.003 per check — a fraction of legacy credit APIs.",
    features: [
      "25 monitored wallets",
      "10,000 scored calls / month",
      "60 requests / minute",
      "Full signal breakdown + insights",
      "Email support",
      "30-day key term — buy again to continue (no card, no auto-renew)",
    ],
  },
  growth: {
    id: "growth",
    name: "Growth",
    priceRlusd: 149,
    monthlyQuota: 100_000,
    rateLimitPerMin: 300,
    overage: false,
    overageRlusdPer1k: 0,
    cacheTtlSeconds: 120,
    watchSlots: 250,
    blurb: "More volume than competitors' Pro tier, for less.",
    features: [
      "250 monitored wallets",
      "100,000 scored calls / month",
      "300 requests / minute",
      "Hard monthly quota: calls past 100,000 are refused (429) until next month or you upgrade",
      "Priority support",
      "30-day key term — buy again to continue (no card, no auto-renew)",
    ],
  },
  scale: {
    id: "scale",
    name: "Scale",
    priceRlusd: 499,
    monthlyQuota: 1_000_000,
    rateLimitPerMin: 1000,
    overage: false,
    overageRlusdPer1k: 0,
    cacheTtlSeconds: 60,
    watchSlots: 2500,
    blurb: "Serious infrastructure. Cheapest per-call at volume, period.",
    features: [
      "2,500 monitored wallets (subject to the shared monitoring capacity)",
      "1,000,000 scored calls / month",
      "1,000 requests / minute",
      "Hard monthly quota: calls past 1,000,000 are refused (429) until next month",
      "Priority support + integration help",
      "30-day key term — buy again to continue (no card, no auto-renew)",
    ],
  },
};

// Monitoring is capped by what the ONE daily monitoring run (the 06:00 UTC cron) can honestly keep up with, so every plan's slots are a
// per-key CEILING and the shared platform limit (MONITOR_MAX_TOTAL_SUBJECTS, default 500 watched wallets across all
// customers) applies first. See docs/MONITORING.md.
export const PLAN_ORDER: PlanId[] = ["free", "starter", "growth", "scale"];

// A paid key is minted with expiresAt = paidAt + this many days. On XRPL rails
// there's no card on file to auto-charge, so access is time-boxed and the
// buyer (human or agent) repurchases. Free + admin keys never expire.
export const PLAN_KEY_TTL_DAYS = 30;

export function getPlan(id: string): Plan {
  return PLANS[(id as PlanId)] ?? PLANS.free;
}

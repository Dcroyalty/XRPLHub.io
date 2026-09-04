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
  overage: boolean;        // true = keep serving past quota and bill it;
                           // false = 429 at quota
  overageRlusdPer1k: number; // price per 1,000 calls over quota (if overage)
  cacheTtlSeconds: number; // score cache lifetime for this tier
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
    blurb: "Score real wallets, no card. Claim a key by connecting Xaman.",
    features: [
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
    blurb: "~$0.003 per check — a fraction of legacy credit APIs.",
    features: [
      "10,000 scored calls / month",
      "60 requests / minute",
      "Full signal breakdown + insights",
      "Email support",
    ],
  },
  growth: {
    id: "growth",
    name: "Growth",
    priceRlusd: 149,
    monthlyQuota: 100_000,
    rateLimitPerMin: 300,
    overage: true,
    overageRlusdPer1k: 2,
    cacheTtlSeconds: 120,
    blurb: "More volume than competitors' Pro tier, for less.",
    features: [
      "100,000 scored calls / month",
      "300 requests / minute",
      "Overage billing — never cut off mid-spike",
      "Priority support",
    ],
  },
  scale: {
    id: "scale",
    name: "Scale",
    priceRlusd: 499,
    monthlyQuota: 1_000_000,
    rateLimitPerMin: 1000,
    overage: true,
    overageRlusdPer1k: 1,
    cacheTtlSeconds: 60,
    blurb: "Serious infrastructure. Cheapest per-call at volume, period.",
    features: [
      "1,000,000 scored calls / month",
      "1,000 requests / minute",
      "Lowest overage rate",
      "Priority support + integration help",
    ],
  },
};

export const PLAN_ORDER: PlanId[] = ["free", "starter", "growth", "scale"];

export function getPlan(id: string): Plan {
  return PLANS[(id as PlanId)] ?? PLANS.free;
}

// lib/plans.ts
// SINGLE SOURCE OF TRUTH for pricing.
//
// The pricing page renders from this. guard.ts enforces from this. The
// checkout charges from this. Change a number here and the advertised
// price, the enforced quota, and the amount charged all move together —
// they can never drift apart.

export type PlanId = "free" | "starter" | "growth";

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
    monthlyQuota: 100,
    rateLimitPerMin: 10,
    overage: false,
    overageRlusdPer1k: 0,
    cacheTtlSeconds: 300,
    blurb: "Kick the tires. Score real wallets, no card.",
    features: [
      "100 scored calls / month",
      "10 requests / minute",
      "300–850 score + 9 signals",
      "Community support",
    ],
  },
  starter: {
    id: "starter",
    name: "Starter",
    priceRlusd: 499,
    monthlyQuota: 50_000,
    rateLimitPerMin: 60,
    overage: false,
    overageRlusdPer1k: 0,
    cacheTtlSeconds: 120,
    blurb: "For a product putting scoring in front of real users.",
    features: [
      "50,000 scored calls / month",
      "60 requests / minute",
      "Full signal breakdown",
      "Email support",
    ],
  },
  growth: {
    id: "growth",
    name: "Growth",
    priceRlusd: 2000,
    monthlyQuota: 500_000,
    rateLimitPerMin: 300,
    overage: true,
    overageRlusdPer1k: 3, // 3 RLUSD per extra 1,000 calls
    cacheTtlSeconds: 60,
    blurb: "Ramps, processors, and agent frameworks at volume.",
    features: [
      "500,000 scored calls / month",
      "300 requests / minute",
      "Overage billing — never cut off mid-spike",
      "Priority support",
    ],
  },
};

export const PLAN_ORDER: PlanId[] = ["free", "starter", "growth"];

export function getPlan(id: string): Plan {
  return PLANS[(id as PlanId)] ?? PLANS.free;
}

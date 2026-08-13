// lib/billing.ts
// Usage rollups + overage math. Read-only helpers over the UsageRecord rows
// that guard.ts writes — so "what do we bill this month" and "what did we
// rate-limit on" are literally the same numbers.

import { prisma } from "@/lib/xrplscore-db";
import { getPlan, type PlanId } from "@/lib/plans";

function monthKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface UsageSummary {
  month: string;
  total: number;
  included: number;
  overageCalls: number;
  overageRlusd: number;
}

/** Current-month usage + overage owed for one key. */
export async function usageForKey(apiKeyId: string): Promise<UsageSummary> {
  const key = await prisma.apiKey.findUnique({ where: { id: apiKeyId } });
  const plan = getPlan(key?.plan ?? "free");
  const mk = monthKey();

  const total = await prisma.usageRecord.count({
    where: { apiKeyId, windowKey: mk },
  });

  const overageCalls = Math.max(0, total - plan.monthlyQuota);
  const overageRlusd =
    plan.overage && overageCalls > 0
      ? Math.ceil(overageCalls / 1000) * plan.overageRlusdPer1k
      : 0;

  return {
    month: mk,
    total,
    included: plan.monthlyQuota,
    overageCalls,
    overageRlusd,
  };
}

/** Advertised monthly price for a plan (base only; overage bills separately). */
export function baseMonthly(planId: PlanId): number {
  return getPlan(planId).priceRlusd;
}

// lib/guard.ts
// Rate limiting + monthly quota, enforced in POSTGRES — not Redis.
//
// Design decision (push back if you disagree): you already run Neon. Adding
// Redis is a second thing to provision, pay for, and page you at 3am. At
// your call volumes, counting rows in an indexed table is fine, and it means
// usage and billing are the same source of truth. If you outgrow it, swap
// this one file for a Redis token bucket — nothing else changes.

import { prisma } from "@/lib/xrplscore-db";
import type { Plan } from "@/lib/plans";

export interface GuardResult {
  ok: boolean;
  status: number;           // 200 if ok, else 429
  reason?: string;
  remaining?: number;       // remaining monthly quota (best-effort)
  overage?: boolean;        // this call is billable overage
  retryAfterSeconds?: number;
}

const BATCH_EXTRA = "screen-batch-extra";

function monthKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Check the per-minute rate limit AND the monthly quota for a key, then
 * record the call. Call this once per scored request, before doing work.
 */
export async function guard(apiKeyId: string, plan: Plan): Promise<GuardResult> {
  const now = new Date();
  const minuteAgo = new Date(now.getTime() - 60_000);

  // 1) Per-minute rate limit
  // "screen-batch-extra" rows are the 2nd..Nth unit of a batch: they count toward the MONTHLY quota, not the per-minute
  // request limit (a batch is one request).
  const lastMinute = await prisma.usageRecord.count({
    where: { apiKeyId, createdAt: { gte: minuteAgo }, endpoint: { not: BATCH_EXTRA } },
  });
  if (lastMinute >= plan.rateLimitPerMin) {
    return {
      ok: false,
      status: 429,
      reason: `Rate limit exceeded (${plan.rateLimitPerMin}/min)`,
      retryAfterSeconds: 60,
    };
  }

  // 2) Monthly quota
  const mk = monthKey(now);
  const used = await prisma.usageRecord.count({
    where: { apiKeyId, windowKey: mk },
  });

  const overQuota = used >= plan.monthlyQuota;
  if (overQuota && !plan.overage) {
    return {
      ok: false,
      status: 429,
      reason: `Monthly quota reached (${plan.monthlyQuota}). Upgrade to keep serving.`,
      remaining: 0,
    };
  }

  // 3) Record the call (this row is both usage AND the billing signal)
  await prisma.usageRecord.create({
    data: { apiKeyId, endpoint: "score", windowKey: mk, overage: overQuota },
  });

  return {
    ok: true,
    status: 200,
    remaining: Math.max(0, plan.monthlyQuota - used - 1),
    overage: overQuota,
  };
}

/**
 * Like guard(), for one request that consumes `units` of the monthly quota (a batch screen: one unit per screened address).
 * The per-minute limit counts the request once. Refused as a whole if the quota cannot cover every unit — never partially served.
 */
export async function guardUnits(apiKeyId: string, plan: Plan, units: number): Promise<GuardResult> {
  if (units <= 1) return guard(apiKeyId, plan);
  const now = new Date();
  const minuteAgo = new Date(now.getTime() - 60_000);
  const lastMinute = await prisma.usageRecord.count({ where: { apiKeyId, createdAt: { gte: minuteAgo }, endpoint: { not: BATCH_EXTRA } } });
  if (lastMinute >= plan.rateLimitPerMin) {
    return { ok: false, status: 429, reason: `Rate limit exceeded (${plan.rateLimitPerMin}/min)`, retryAfterSeconds: 60 };
  }
  const mk = monthKey(now);
  const used = await prisma.usageRecord.count({ where: { apiKeyId, windowKey: mk } });
  if (!plan.overage && used + units > plan.monthlyQuota) {
    return {
      ok: false,
      status: 429,
      reason: `This batch needs ${units} calls but only ${Math.max(0, plan.monthlyQuota - used)} remain of your monthly quota (${plan.monthlyQuota}). Nothing was screened or charged.`,
      remaining: Math.max(0, plan.monthlyQuota - used),
    };
  }
  await prisma.usageRecord.createMany({
    data: [
      { apiKeyId, endpoint: "screen-batch", windowKey: mk, overage: false },
      ...Array.from({ length: units - 1 }, () => ({ apiKeyId, endpoint: BATCH_EXTRA, windowKey: mk, overage: false })),
    ],
  });
  return { ok: true, status: 200, remaining: Math.max(0, plan.monthlyQuota - used - units), overage: false };
}

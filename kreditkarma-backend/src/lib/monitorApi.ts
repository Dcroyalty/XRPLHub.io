// src/lib/monitorApi.ts
// Shared helpers for the /api/monitor routes: key auth, error shape, the public capability description.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { extractKey, resolveApiKey, type ResolvedKey } from "@/lib/keys";
import { PLANS, PLAN_ORDER } from "@/lib/plans";
import { CONSUMER_ACK_TEXT, CONSUMER_ACK_VERSION, MONITOR_CANON_VERSION, MONITOR_DISCLAIMER } from "@/lib/monitorCanon";
import { EVENT_TYPES, maxTotalSubjects, DEFAULT_SCORE_BUDGET, RESCORE_AFTER_MS, HEARTBEAT_AFTER_MS } from "@/lib/monitorEngine";
import { lendingProtocolActive } from "@/lib/lendingLedger";

export const BATCH_CAP = 25;
export const SUBSCRIBES_PER_HOUR = 10;
/**
 * The most of the shared capacity FREE-plan keys may hold between them. Free keys are cheap to farm (one per
 * activated wallet), so without a ceiling a handful of them could fill the whole platform cap and lock paying
 * customers out. Paid keys may use everything free keys have not taken; at least (1 - this) of the cap is
 * therefore always reserved for them.
 */
export const FREE_CAPACITY_SHARE = 0.4;
export const freeTierCap = () => Math.floor(maxTotalSubjects() * FREE_CAPACITY_SHARE);

export function err(status: number, code: string, message: string, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ error: code, message, ...extra }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function authKey(req: Request): Promise<{ ok: true; key: ResolvedKey } | { ok: false; res: NextResponse }> {
  const r = await resolveApiKey(extractKey(req));
  if (r.ok) return { ok: true, key: r.key };
  if (r.reason === "expired") {
    return { ok: false, res: err(402, "key_expired", `This API key's term ended at ${r.expiredAt}. Purchase a new key to continue.`, { renew: "https://www.xrplhub.io/pricing" }) };
  }
  return { ok: false, res: err(401, "unauthorized", "Missing or invalid API key. A free key works — see https://www.xrplhub.io/pricing.") };
}

/** The acknowledgement the caller must send, with the exact text they are accepting. */
export function ackRequired(): NextResponse {
  return err(400, "acknowledgement_required", "Monitoring requires the consumer-use acknowledgement. Send acknowledgement: { accepted: true, version } exactly as below.", {
    acknowledgementVersion: CONSUMER_ACK_VERSION,
    acknowledgementText: CONSUMER_ACK_TEXT,
  });
}

export function ackOk(body: unknown): boolean {
  const a = (body as { acknowledgement?: { accepted?: unknown; version?: unknown } } | null)?.acknowledgement;
  return !!a && a.accepted === true && a.version === CONSUMER_ACK_VERSION;
}

export async function capabilities(): Promise<Record<string, "active" | "awaiting_amendment">> {
  const loans = (await lendingProtocolActive().catch(() => false)) ? "active" : "awaiting_amendment";
  return {
    score_drop: "active",
    sanctions_hit: "active",
    sanctions_delisted: "active",
    monitoring_degraded: "active",
    first_loan_observed: loans,
    loan_overdue: loans,
    loan_impaired: loans,
    loan_defaulted: loans,
  };
}

export async function slotUsage(apiKeyId: string): Promise<{ used: number; total: number }> {
  const [used, total] = await Promise.all([
    prisma.monitorSubject.count({ where: { subscription: { apiKeyId, status: { not: "deleted" } } } }),
    prisma.monitorSubject.count({ where: { subscription: { status: { not: "deleted" } } } }),
  ]);
  return { used, total };
}

/** Watched wallets held by FREE-plan keys. Subscriptions carry only apiKeyId, so resolve the plans in two small steps. */
export async function freeTierUsage(): Promise<number> {
  const subs = await prisma.monitorSubscription.findMany({ where: { status: { not: "deleted" } }, select: { apiKeyId: true }, distinct: ["apiKeyId"] });
  if (!subs.length) return 0;
  const free = await prisma.apiKey.findMany({ where: { id: { in: subs.map((x) => x.apiKeyId) }, plan: "free" }, select: { id: true } });
  if (!free.length) return 0;
  return prisma.monitorSubject.count({ where: { subscription: { apiKeyId: { in: free.map((k) => k.id) }, status: { not: "deleted" } } } });
}

/**
 * Would adding `adding` wallets (and removing `removing`) breach the shared cap or, for a free key, the free-tier
 * ceiling? Returns the refusal to send, or null. (Checked read-then-write, so two simultaneous requests can overshoot
 * by a few wallets; the daily pass tolerates that and the next subscribe is refused.)
 */
export async function capacityRefusal(key: ResolvedKey, totalUsed: number, adding: number, removing = 0): Promise<NextResponse | null> {
  const cap = maxTotalSubjects();
  if (totalUsed - removing + adding > cap) {
    return err(503, "monitoring_capacity_reached", `Monitoring is capped at ${cap} watched wallets platform-wide (what the daily monitoring run can keep current) and is full. Try again later.`, { sharedLimit: cap, currentlyWatched: totalUsed });
  }
  if (key.planId === "free") {
    const fc = freeTierCap();
    const freeUsed = await freeTierUsage();
    if (freeUsed - removing + adding > fc) {
      return err(503, "monitoring_free_capacity_reached", `Free-tier monitoring is capped at ${fc} watched wallets platform-wide so that ${cap - fc} of the ${cap} slots always stay available to paid plans, and that pool is full. A paid plan can still add wallets.`, {
        freeTierLimit: fc, freeTierWatched: freeUsed, sharedLimit: cap, upgrade: "https://www.xrplhub.io/pricing",
      });
    }
  }
  return null;
}

export async function describeMonitoring(): Promise<Record<string, unknown>> {
  const total = await prisma.monitorSubject.count({ where: { subscription: { status: { not: "deleted" } } } }).catch(() => null);
  const cap = maxTotalSubjects();
  return {
    product: "XRPLHub continuous monitoring",
    canonVersion: MONITOR_CANON_VERSION,
    positioning:
      "Layered on top of your underwriting, not a replacement. Underwriting judges structural risk before signing; monitoring reports " +
      "observed behavioral changes in public XRP Ledger data after — once a day, for wallets you choose.",
    cadence:
      "One check per watched wallet per day, run by the platform's daily cron. It is NOT real-time. A cheap account-state check runs every " +
      "day; a fresh XRPLScore is computed only when the account changed, or at least weekly, within a per-run budget of about " +
      `${DEFAULT_SCORE_BUDGET} fresh scores.`,
    capacity: {
      statement:
        `Monitoring is capped at ${cap} watched wallets across ALL customers, sized for the ONE daily monitoring run (06:00 UTC). ` +
        `Free-plan keys can hold at most ${freeTierCap()} of those between them, so ${cap - freeTierCap()} slots always stay available to paid plans. ` +
        "Plan slots below are per-key ceilings; the shared limit applies first. If more wallets are due than one run can score, the stalest " +
        "are checked first and the rest roll to the next run — each watched wallet exposes lastCheckedAt / nextCheckAt so you can see it.",
      sharedLimit: cap,
      freeTierLimit: freeTierCap(),
      reservedForPaid: cap - freeTierCap(),
      currentlyWatched: total,
      freshScoresPerRun: DEFAULT_SCORE_BUDGET,
      rescoreAtLeastEveryDays: RESCORE_AFTER_MS / 86_400_000,
      heartbeatEveryDays: HEARTBEAT_AFTER_MS / 86_400_000,
    },
    limits: {
      batchCap: BATCH_CAP,
      subscribesPerHourPerKey: SUBSCRIBES_PER_HOUR,
      watchSlotsByPlan: Object.fromEntries(PLAN_ORDER.map((id) => [id, PLANS[id].watchSlots])),
    },
    events: EVENT_TYPES,
    capabilities: await capabilities(),
    scoreDrop:
      "Only fires if YOU set scoreDropPoints (1–550). There is no default threshold: we have no stored basis for one. It is measured from " +
      "the highest fresh score observed since you subscribed or since the last score_drop alert, and never across a methodology change.",
    notObserved: "Off-ledger behavior, borrower credit, collateral, legal structure, counterparties of a sanctioned wallet. No probability of default. No recommendation.",
    acknowledgement: { version: CONSUMER_ACK_VERSION, text: CONSUMER_ACK_TEXT, storedWith: "each subscription (timestamp + version)" },
    endpoints: {
      info: "GET /api/monitor",
      subscribe: "POST /api/monitor/subscribe  { addresses[≤25], webhookUrl, scoreDropPoints?, subscriptionId?, acknowledgement:{accepted:true,version} }",
      list: "GET /api/monitor/subscriptions",
      manage: "PATCH | DELETE /api/monitor/subscriptions/{id}",
      history: "GET /api/monitor/history?subject=r...&limit=&before=",
      events: "GET /api/monitor/events?subscriptionId=&since=",
      verify: "GET /api/attest/verify?queryId={observationId}",
    },
    webhooks: {
      signing:
        "X-XRPLHub-Signature: v1=<hex HMAC-SHA256(secret, `${X-XRPLHub-Timestamp}.${rawBody}`)>. Reject timestamps older than 5 minutes; de-duplicate on X-XRPLHub-Event-Id (retries reuse it).",
      secret: "Generated per subscription, shown once at creation (or rotation), never derived from your API key.",
      delivery: `https only, port 443, public hostnames only; test ping on subscribe; retried up to 6 times over ~3 days from the daily runs; auto-disabled after 8 consecutive failed attempts (events stay readable via GET /api/monitor/events).`,
    },
    disclaimer: MONITOR_DISCLAIMER,
  };
}

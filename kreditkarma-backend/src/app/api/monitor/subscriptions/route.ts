// GET /api/monitor/subscriptions — this key's subscriptions and watchlists (the signing secret is never returned).
import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { authKey, slotUsage } from "@/lib/monitorApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await authKey(req);
  if (!auth.ok) return auth.res;
  const key = auth.key;

  const subs = await prisma.monitorSubscription.findMany({
    where: { apiKeyId: key.id, status: { not: "deleted" } },
    orderBy: { createdAt: "asc" },
    include: { subjects: { orderBy: { createdAt: "asc" } } },
  });
  const usage = await slotUsage(key.id);
  return NextResponse.json(
    {
      slots: { used: usage.used, max: key.plan.watchSlots },
      subscriptions: subs.map((s) => ({
        id: s.id,
        webhookUrl: s.webhookUrl,
        status: s.status,
        webhookFailures: s.webhookFailures,
        webhookDisabledAt: s.webhookDisabledAt ? s.webhookDisabledAt.toISOString() : null,
        scoreDropPoints: s.scoreDropPoints,
        consumerAcknowledgement: { at: s.consumerAckAt.toISOString(), version: s.consumerAckVersion },
        createdAt: s.createdAt.toISOString(),
        subjects: s.subjects.map((j) => ({
          address: j.address,
          lastCheckedAt: j.lastCheckedAt ? j.lastCheckedAt.toISOString() : null,
          nextCheckAt: j.nextCheckAt.toISOString(),
          lastScoredAt: j.lastScoredAt ? j.lastScoredAt.toISOString() : null,
          lastScore: j.lastScore,
          sanctionListed: j.sanctionListed,
          consecutiveFailedChecks: j.consecutiveFailures,
        })),
      })),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

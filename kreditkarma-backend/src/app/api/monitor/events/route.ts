// GET /api/monitor/events?subscriptionId=&since=<ISO>&limit=
// The same events a webhook would push, readable back — so a missed delivery (or a disabled webhook) never loses one.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { authKey, err } from "@/lib/monitorApi";
import { MONITOR_DISCLAIMER } from "@/lib/monitorCanon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await authKey(req);
  if (!auth.ok) return auth.res;
  const url = new URL(req.url);
  const subscriptionId = url.searchParams.get("subscriptionId");
  const sinceRaw = url.searchParams.get("since");
  const since = sinceRaw ? new Date(sinceRaw) : null;
  if (since && Number.isNaN(since.getTime())) return err(400, "bad_request", "since must be an ISO timestamp.");
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100));

  const events = await prisma.monitorEvent.findMany({
    where: {
      subscription: { apiKeyId: auth.key.id, ...(subscriptionId ? { id: subscriptionId } : {}) },
      ...(since ? { createdAt: { gt: since } } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  return NextResponse.json(
    {
      events: events.map((e) => ({
        id: e.id,
        type: e.type,
        subscriptionId: e.subscriptionId,
        subject: e.subject,
        createdAt: e.createdAt.toISOString(),
        data: e.payload,
        observationId: e.observationId,
        verify: e.observationId ? `https://www.xrplhub.io/api/attest/verify?queryId=${e.observationId}` : null,
        delivery: { state: e.state, attempts: e.attempts, deliveredAt: e.deliveredAt ? e.deliveredAt.toISOString() : null, lastError: e.lastError },
      })),
      next: events.length === limit ? events[events.length - 1].createdAt.toISOString() : null,
      disclaimer: MONITOR_DISCLAIMER,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

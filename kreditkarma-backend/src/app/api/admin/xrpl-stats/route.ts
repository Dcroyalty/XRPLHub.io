// src/app/api/admin/xrpl-stats/route.ts
// GET /api/admin/xrpl-stats  (admin) — lightweight XRPL rate-limit visibility.
//
// Returns per-day call counts by method, cache hit rate, per-node usage, and the
// live node-pool cooldown state. Approximate (in-memory deltas flush on a
// throttle; a cold lambda loses its unflushed counts) — enough to see if we are
// anywhere near a node's quota.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { isAdmin, adminUnauthorized } from "@/lib/adminAuth";
import { forceFlushXrplCounters } from "@/lib/xrplCounters";
import { nodePoolStatus, XRPL_NODES } from "@/lib/xrplNodes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// xrplcluster's published policy, for context in the response.
const QUOTA_NOTE = {
  xrplcluster: '"units-10" q=2000 w=10s · "units-60" q=10000 w=60s · "units-3600" q=500000 w=1h · per IP /64',
  approxUnitsPerScore: "~250-400 (two trimmed calls dominate; see src/lib/xrplscore.ts)",
};

export async function GET(req: Request) {
  if (!isAdmin(req)) return adminUnauthorized();

  forceFlushXrplCounters(prisma);
  await new Promise((r) => setTimeout(r, 150)); // let the fire-and-forget flush land

  const days = Number(new URL(req.url).searchParams.get("days") ?? 7);
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  const rows = await prisma.xrplCallStat.findMany({
    where: { day: { gte: since } },
    orderBy: [{ day: "desc" }, { calls: "desc" }],
  });

  const byDay: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    (byDay[r.day] ??= {})[r.method] = r.calls;
  }

  const totals: Record<string, number> = {};
  for (const r of rows) totals[r.method] = (totals[r.method] ?? 0) + r.calls;

  const hits = totals["cache:hit"] ?? 0;
  const misses = totals["cache:miss"] ?? 0;
  const cacheHitRate = hits + misses > 0 ? Math.round((hits / (hits + misses)) * 100) : null;

  const nodeCalls = Object.fromEntries(
    Object.entries(totals).filter(([k]) => k.startsWith("node:")).map(([k, v]) => [k.slice(5), v])
  );

  return NextResponse.json(
    {
      windowDays: days,
      cache: { hits, misses, hitRatePct: cacheHitRate },
      callsByMethod: Object.fromEntries(
        Object.entries(totals)
          .filter(([k]) => k.startsWith("method:"))
          .map(([k, v]) => [k.slice(7), v])
          .sort((a, b) => (b[1] as number) - (a[1] as number))
      ),
      callsByNode: nodeCalls,
      rateLimitedByNode: Object.fromEntries(
        Object.entries(totals).filter(([k]) => k.startsWith("ratelimited:")).map(([k, v]) => [k.slice(12), v])
      ),
      rpcExhausted: totals["rpc:exhausted"] ?? 0,
      byDay,
      nodePool: { size: XRPL_NODES.length, live: nodePoolStatus() },
      quotaNote: QUOTA_NOTE,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

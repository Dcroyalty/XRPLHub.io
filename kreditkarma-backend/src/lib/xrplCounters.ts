// src/lib/xrplCounters.ts
// Lightweight, best-effort call counters. In-memory deltas, flushed to the
// XrplCallStat table (one row per UTC day per method). Not exact — a cold
// lambda start loses its unflushed deltas — but more than enough to answer
// "are we anywhere near a rate-limit ceiling?".

import type { PrismaClient } from "@prisma/client";

const deltas = new Map<string, number>(); // key: "YYYY-MM-DD|method"
let lastFlush = 0;
const FLUSH_MIN_INTERVAL_MS = 20_000;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Record N calls of `method` (an XRPL method, or "cache:hit"/"cache:miss"/"node:<host>"). */
export function bumpXrpl(method: string, n = 1): void {
  const key = `${today()}|${method}`;
  deltas.set(key, (deltas.get(key) ?? 0) + n);
}

/** Fire-and-forget: push accumulated deltas to the DB and clear them. Cheap at
 *  low volume (a handful of upserts); throttled so a burst doesn't hammer Neon. */
export function flushXrplCounters(prisma: PrismaClient): void {
  if (deltas.size === 0) return;
  if (Date.now() - lastFlush < FLUSH_MIN_INTERVAL_MS) return;
  lastFlush = Date.now();

  const pending = [...deltas.entries()];
  deltas.clear();

  void Promise.allSettled(
    pending.map(([key, calls]) => {
      const [day, method] = key.split("|");
      return prisma.xrplCallStat.upsert({
        where: { day_method: { day, method } },
        update: { calls: { increment: calls } },
        create: { day, method, calls },
      });
    })
  ).then((results) => {
    // Re-queue any that failed so we don't silently lose counts.
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        const [key, calls] = pending[i];
        deltas.set(key, (deltas.get(key) ?? 0) + calls);
      }
    });
  });
}

/** Force a flush regardless of throttle — for cron catch-all. */
export function forceFlushXrplCounters(prisma: PrismaClient): void {
  lastFlush = 0;
  flushXrplCounters(prisma);
}

// src/lib/rateLimit.ts
// A small sliding-window limiter for endpoints that have no API key to meter (create-payment, check-payment).
//
// HONEST LIMITS: the counters live in this server instance's memory. On Vercel a burst is spread over a few warm
// instances, so the effective ceiling is roughly (limit x instances) — this stops a single client hammering the
// Xaman / XRPL-node / database calls behind these routes, it is NOT a global hard cap. A global cap needs shared
// state (a database table or a Vercel WAF rate-limit rule). Keyed on the client IP Vercel reports.

import { NextResponse } from "next/server";
import { clientIp } from "@/lib/freeKey";

const hits = new Map<string, number[]>();
const MAX_KEYS = 5_000;

export type RateResult = { ok: true } | { ok: false; retryAfterSeconds: number };

export function rateLimit(req: Request, bucket: string, limit: number, windowMs: number): RateResult {
  const now = Date.now();
  const key = `${bucket}|${clientIp(req)}`;
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000)) };
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > MAX_KEYS) {
    // bound memory: drop everything that has aged out, and if that is not enough, the oldest keys
    for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] >= windowMs) hits.delete(k);
    while (hits.size > MAX_KEYS) hits.delete(hits.keys().next().value as string);
  }
  return { ok: true };
}

/** The 429 every limited route returns. */
export function rateLimited(r: { ok: false; retryAfterSeconds: number }): NextResponse {
  return NextResponse.json(
    { error: "rate_limited", message: "Too many requests from this address — slow down and retry shortly.", retryAfterSeconds: r.retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(r.retryAfterSeconds), "Cache-Control": "no-store" } }
  );
}

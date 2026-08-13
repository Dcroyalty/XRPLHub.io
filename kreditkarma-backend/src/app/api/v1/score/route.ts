// app/api/v1/score/route.ts
// The product. GET /api/v1/score?wallet=r...  (also accepts POST { wallet }).
// Auth with an API key, enforce plan limits, return the SAME number the
// site returns (both call computeScore from lib/engine.ts).

import { NextResponse } from "next/server";
import { extractKey, resolveApiKey } from "@/lib/keys";
import { guard } from "@/lib/guard";
import { computeScore, isValidXrplAddress } from "@/lib/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // never cache the auth'd response itself

async function handle(wallet: string | null, req: Request) {
  // 1) Auth
  const key = await resolveApiKey(extractKey(req));
  if (!key) {
    return NextResponse.json(
      { error: "unauthorized", message: "Missing or invalid API key." },
      { status: 401 }
    );
  }

  // 2) Validate input
  if (!wallet || !isValidXrplAddress(wallet)) {
    return NextResponse.json(
      { error: "bad_request", message: "Provide a valid XRPL wallet address." },
      { status: 400 }
    );
  }

  // 3) Rate limit + quota (records the call)
  const g = await guard(key.id, key.plan);
  if (!g.ok) {
    return NextResponse.json(
      { error: "rate_limited", message: g.reason },
      {
        status: g.status,
        headers: g.retryAfterSeconds
          ? { "Retry-After": String(g.retryAfterSeconds) }
          : undefined,
      }
    );
  }

  // 4) Score
  try {
    const result = await computeScore(wallet);
    return NextResponse.json(
      { data: result, plan: key.planId, remaining: g.remaining, overage: g.overage },
      {
        headers: {
          // Cache TTL varies by tier (decision from the plan table).
          "Cache-Control": `private, max-age=${key.plan.cacheTtlSeconds}`,
          "X-RateLimit-Remaining": String(g.remaining ?? ""),
        },
      }
    );
  } catch (err) {
    // computeScore throws until you wire it. Surface a clear 501, not a 500.
    const message = err instanceof Error ? err.message : "scoring failed";
    return NextResponse.json(
      { error: "not_implemented", message },
      { status: 501 }
    );
  }
}

export async function GET(req: Request) {
  const wallet = new URL(req.url).searchParams.get("wallet");
  return handle(wallet, req);
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { wallet?: string };
  return handle(body.wallet ?? null, req);
}

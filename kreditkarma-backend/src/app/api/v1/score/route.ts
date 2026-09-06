// app/api/v1/score/route.ts
// The product. GET /api/v1/score?wallet=r...  (also accepts POST { wallet }).
// Auth with an API key, enforce plan limits, return the SAME number the
// site returns (both call computeScore from lib/engine.ts).

import { NextResponse } from "next/server";
import { extractKey, resolveApiKey } from "@/lib/keys";
import { guard } from "@/lib/guard";
import { computeScore, isValidXrplAddress, AccountNotFoundError } from "@/lib/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // never cache the auth'd response itself

const RENEW = {
  pricing: "https://www.xrplhub.io/pricing",
  checkoutXrpRlusd: "https://www.xrplhub.io/checkout?plan={starter|growth|scale}",
  checkoutUsdc: "https://www.xrplhub.io/api/checkout/usdc/{starter|growth|scale}",
};

async function handle(wallet: string | null, req: Request) {
  // 1) Auth
  const r = await resolveApiKey(extractKey(req));
  if (!r.ok) {
    if (r.reason === "expired") {
      // Distinct from a bad key: the key WAS valid, its 30-day term ended.
      // 402 + machine-readable renewal pointers so an agent can re-buy without
      // a human. (XRPL rails = no card on file; access is time-boxed.)
      return NextResponse.json(
        {
          error: "key_expired",
          message: `This API key's 30-day term ended at ${r.expiredAt}. Purchase a new key to continue.`,
          expiredAt: r.expiredAt,
          renew: RENEW,
        },
        { status: 402, headers: { "Cache-Control": "no-store" } }
      );
    }
    return NextResponse.json(
      { error: "unauthorized", message: "Missing or invalid API key." },
      { status: 401 }
    );
  }
  const key = r.key;

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
    const expiresSoon =
      !!key.expiresAt && new Date(key.expiresAt).getTime() - Date.now() < 72 * 3600_000;
    const headers: Record<string, string> = {
      // Cache TTL varies by tier (decision from the plan table).
      "Cache-Control": `private, max-age=${key.plan.cacheTtlSeconds}`,
      "X-RateLimit-Remaining": String(g.remaining ?? ""),
    };
    if (key.expiresAt) headers["X-Key-Expires"] = key.expiresAt;
    if (expiresSoon) headers["X-Key-Expires-Soon"] = "true";
    return NextResponse.json(
      {
        data: result,
        plan: key.planId,
        remaining: g.remaining,
        overage: g.overage,
        keyExpiresAt: key.expiresAt,
        ...(expiresSoon ? { keyExpiresSoon: true, renew: RENEW } : {}),
      },
      { headers }
    );
  } catch (err) {
    if (err instanceof AccountNotFoundError) {
      return NextResponse.json(
        { error: "not_found", message: "That wallet is not an activated account on XRPL mainnet." },
        { status: 404 }
      );
    }
    const message = err instanceof Error ? err.message : "scoring failed";
    return NextResponse.json({ error: "scoring_failed", message }, { status: 502 });
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

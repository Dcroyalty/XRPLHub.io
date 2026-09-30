// src/app/api/mpp/[resource]/route.ts
// Machine Payments Protocol (Stripe/Tempo's spec, via xrpl-mpp-sdk) acceptance, alongside x402 --
// its own code path, deliberately never touching x402.ts/x402Dual.ts or their idempotency/settlement
// logic. Feature-flagged OFF by default (MPP_ENABLED unset or not "true") -- see docs/AUTONOMY.md's
// MPP section for exactly what's still needed before this can be turned on.
//
// STATUS: scaffold only, not a working integration. What's actually built: the isolated route slot and
// the kill switch, both verified to fail closed. What's NOT built yet (all required before flipping
// MPP_ENABLED on): the xrpl-mpp-sdk + mppx dependency (xrpl-mpp-sdk is still beta -- 0.1.0-beta.3 as of
// 2026-09-29, checked on npm directly, not from memory), a durable replay store (their docs require
// Postgres or DynamoDB -- an in-memory store is explicitly dev-only), and an HMAC secret
// (MPP_CHALLENGE_SECRET, `openssl rand -base64 32`) for challenge signing. None of that is safe to
// half-build, so none of it is here yet -- an unfinished payment-acceptance path is worse than no path.
//
// Their peer dependency range (xrpl >=4.0.0 <5.0.0) is exactly what this project already runs (4.6.0),
// confirmed compatible -- but see docs/AUTONOMY.md sec 11: it is NOT compatible with the Batch
// transaction type (needs xrpl.js 5.1.0+). Building MPP forecloses Batch and vice versa; don't start
// wiring the real SDK in without re-confirming that tradeoff still holds.

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function mppEnabled(): boolean {
  return process.env.MPP_ENABLED === "true";
}

export async function GET(req: Request, ctx: { params: Promise<{ resource: string }> }) {
  return handle(req, ctx);
}
export async function POST(req: Request, ctx: { params: Promise<{ resource: string }> }) {
  return handle(req, ctx);
}

async function handle(_req: Request, _ctx: { params: Promise<{ resource: string }> }) {
  if (!mppEnabled()) {
    return NextResponse.json(
      {
        error: "mpp_not_enabled",
        message: "Machine Payments Protocol acceptance is not enabled on this deployment. Use x402 (see /.well-known/x402) instead.",
      },
      { status: 404 }
    );
  }
  // Never reached while the flag is off. Left as an explicit, loud failure (not a silent 200) so
  // turning the flag on without finishing the integration is immediately obvious, not a slow-burn bug.
  return NextResponse.json(
    { error: "mpp_not_implemented", message: "MPP_ENABLED is true but the integration itself is not built yet. See this file's header comment." },
    { status: 501 }
  );
}

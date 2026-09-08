// src/app/api/lending/exposure/route.ts
// GET /api/lending/exposure?borrower=r...   (also POST { borrower })
//
// A borrower's total XLS-66 lending exposure across ALL loan brokers, in one
// call. The XRP Ledger has no aggregate borrower-debt object. Free tier = the
// aggregate + observation summary; the paid route adds every loan decoded, the
// per-broker first-loss context, and the Merkle-anchored attestation.
//
// EVERY call persists an immutable LendingExposureSnapshot — a query is a free
// observation of state that may not exist tomorrow (a defaulted loan can be
// deleted by either party). Pre-activation this returns 503 but still carries the
// borrower's XRPLScore; it serves automatically when the amendment enables.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { extractKey, resolveApiKey } from "@/lib/keys";
import { guard } from "@/lib/guard";
import { runExposureQuery, isValidXrplAddress } from "@/lib/lendingExposure";
import { XrplUnavailableError } from "@/lib/engine";
import { LENDING_PROTOCOL_AMENDMENT_ID } from "@/lib/lendingLedger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const RENEW = { pricing: "https://www.xrplhub.io/pricing" };
const VERIFY_BASE = "https://www.xrplhub.io/api/attest/verify?queryId=";

async function handle(borrower: string | null, req: Request) {
  const r = await resolveApiKey(extractKey(req));
  if (!r.ok) {
    if (r.reason === "expired") {
      return NextResponse.json(
        { error: "key_expired", message: `This API key's term ended at ${r.expiredAt}.`, expiredAt: r.expiredAt, renew: RENEW },
        { status: 402, headers: { "Cache-Control": "no-store" } }
      );
    }
    return NextResponse.json(
      { error: "unauthorized", message: "Missing or invalid API key. A free key works — see /pricing." },
      { status: 401 }
    );
  }

  if (!borrower || !isValidXrplAddress(borrower)) {
    return NextResponse.json({ error: "bad_request", message: "Provide a valid XRPL address: ?borrower=r..." }, { status: 400 });
  }

  const g = await guard(r.key.id, r.key.plan);
  if (!g.ok) {
    return NextResponse.json(
      { error: "rate_limited", message: g.reason },
      { status: g.status, headers: g.retryAfterSeconds ? { "Retry-After": String(g.retryAfterSeconds) } : undefined }
    );
  }

  try {
    const out = await runExposureQuery(prisma, borrower, `key:${r.key.keyPrefix}`);

    if (!out.amendmentActive) {
      return NextResponse.json(
        {
          status: "amendment-not-active",
          amendment: "LendingProtocol",
          amendmentId: LENDING_PROTOCOL_AMENDMENT_ID,
          message:
            "The XRPL Lending Protocol (XLS-66) is not yet enabled on mainnet. This endpoint serves automatically on activation — no redeploy. The XRPLScore below is live.",
          borrower: out.borrower,
          ledgerIndex: out.ledgerIndex,
          xrplScore: out.xrplScore,
          grade: out.grade,
          observation: out.observation,
          disclaimer: out.disclaimer,
        },
        { status: 503, headers: { "Retry-After": "86400", "Cache-Control": "no-store" } }
      );
    }

    // Free tier: aggregate + observation summary. No per-loan / per-broker detail.
    return NextResponse.json(
      {
        borrower: out.borrower,
        amendmentActive: true,
        ledgerIndex: out.ledgerIndex,
        ledgerCloseAt: out.ledgerCloseAt,
        asOf: out.generatedAt,
        disposition: out.disposition,
        exposure: out.exposure,
        events: out.events,
        worstStatus: out.worstStatus,
        earliestNextPaymentDue: out.earliestNextPaymentDue,
        xrplScore: out.xrplScore,
        grade: out.grade,
        observation: out.observation,
        attestation: {
          queryId: out.queryId,
          canonVersion: "lending-exposure-v1",
          leafHash: out.leafHash,
          anchor: { status: "pending", note: "Recorded now; included in the next daily Merkle anchor." },
          verify: `${VERIFY_BASE}${out.queryId}`,
        },
        detail: {
          url: `https://www.xrplhub.io/api/x402/lending/exposure?borrower=${out.borrower}`,
          price: "0.01 USDC (x402, Base)",
          adds: "every loan decoded, per-broker first-loss context (DebtTotal / CoverAvailable), the last-known state of every vanished loan",
        },
        history: `https://www.xrplhub.io/api/lending/history?borrower=${out.borrower}`,
        disclaimer: out.disclaimer,
      },
      { headers: { "X-Attestation-Id": out.queryId, "Cache-Control": "no-store" } }
    );
  } catch (err) {
    if (err instanceof XrplUnavailableError) {
      // Could not read the borrower's XRPLScore inputs — nothing was persisted or
      // attested. Retryable; the amendment gate is unrelated to this failure.
      return NextResponse.json(
        { error: "xrpl_unavailable", message: err.message, failedCalls: err.failedCalls, retryable: true },
        { status: 503, headers: { "Retry-After": "15", "Cache-Control": "no-store" } }
      );
    }
    const message = err instanceof Error ? err.message : "exposure query failed";
    return NextResponse.json({ error: "exposure_failed", message }, { status: 502 });
  }
}

export async function GET(req: Request) {
  return handle(new URL(req.url).searchParams.get("borrower"), req);
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { borrower?: string };
  return handle(body.borrower ?? null, req);
}

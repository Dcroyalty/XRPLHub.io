// src/app/api/screen/ofac/route.ts
// GET /api/screen/ofac?address=r...   (also POST { address })
//
// Compares ONE XRPL address against a pinned snapshot of the OFAC SDN list
// (exact address-string match only) and returns a factual, Merkle-anchored
// receipt. A "no match" means the address was not on that list version — NOT
// that it is clean or unsanctioned. Not legal/compliance advice; does not
// discharge the caller's screening obligations. See src/lib/screenCanon.ts and
// GET /api/attest/anchor for the frozen canonicalisation, /legal/screening for
// the full terms.
//
// Auth: any active API key (the free tier works). Metered via guard() like a
// score call. Every screen — match OR no-match — writes a full receipt, gets a
// leaf, and lands in the next daily anchor batch.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { extractKey, resolveApiKey } from "@/lib/keys";
import { guard } from "@/lib/guard";
import { isValidXrplAddress } from "@/lib/engine";
import { XRPL_NODES } from "@/lib/xrplscore";
import { runOfacScreen, NoSnapshotError, SCREEN_DISCLAIMER_SHORT } from "@/lib/screen";
import { SCREEN_CANON_VERSION } from "@/lib/screenCanon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

const RENEW = { pricing: "https://www.xrplhub.io/pricing" };
const VERIFY_BASE = "https://www.xrplhub.io/api/attest/verify?queryId=";

/** Pin the current VALIDATED ledger index as a time anchor for the screen.
 *  Independent of whether the subject is an activated account. 0 on total
 *  failure — the receipt records that honestly. */
async function pinValidatedLedger(): Promise<number> {
  for (const url of XRPL_NODES) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "ledger", params: [{ ledger_index: "validated" }] }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) continue;
      const j = (await res.json()) as {
        result?: { ledger_index?: number; ledger?: { ledger_index?: number | string } };
      };
      const li = Number(j.result?.ledger_index ?? j.result?.ledger?.ledger_index ?? 0);
      if (Number.isFinite(li) && li > 0) return li;
    } catch {
      /* try next node */
    }
  }
  return 0;
}

async function handle(address: string | null, req: Request) {
  const r = await resolveApiKey(extractKey(req));
  if (!r.ok) {
    if (r.reason === "expired") {
      return NextResponse.json(
        {
          error: "key_expired",
          message: `This API key's term ended at ${r.expiredAt}. Purchase a new key to continue.`,
          expiredAt: r.expiredAt,
          renew: RENEW,
        },
        { status: 402, headers: { "Cache-Control": "no-store" } }
      );
    }
    return NextResponse.json(
      { error: "unauthorized", message: "Missing or invalid API key. A free key works — see /pricing." },
      { status: 401 }
    );
  }

  if (!address || !isValidXrplAddress(address)) {
    return NextResponse.json(
      { error: "bad_request", message: "Provide a valid XRPL address: ?address=r..." },
      { status: 400 }
    );
  }

  const g = await guard(r.key.id, r.key.plan);
  if (!g.ok) {
    return NextResponse.json(
      { error: "rate_limited", message: g.reason },
      { status: g.status, headers: g.retryAfterSeconds ? { "Retry-After": String(g.retryAfterSeconds) } : undefined }
    );
  }

  const ledgerIndex = await pinValidatedLedger();

  try {
    const out = await runOfacScreen(prisma, address, `key:${r.key.keyPrefix}`, ledgerIndex);
    return NextResponse.json(
      {
        attestation: {
          queryId: out.queryId,
          canonVersion: SCREEN_CANON_VERSION,
          engineVersion: out.leaf.engineVersion,
          leafHash: out.leafHash,
          anchor: {
            status: "pending",
            note: "Recorded now; included in the next daily Merkle anchor. Poll the verify URL.",
          },
          verify: `${VERIFY_BASE}${out.queryId}`,
        },
        subject: out.leaf.subjectAddress,
        screenedAt: out.leaf.screenedAt,
        method: "exact-match",
        ledgerIndex,
        lists: out.leaf.lists,
        result: out.leaf.result,
        statement: out.statement,
        canonicalLeaf: out.canonicalJson,
        disclaimer: SCREEN_DISCLAIMER_SHORT,
      },
      {
        headers: {
          "X-Attestation-Id": out.queryId,
          "Cache-Control": "no-store",
        },
      }
    );
  } catch (err) {
    if (err instanceof NoSnapshotError) {
      return NextResponse.json(
        { error: "not_ready", message: err.message },
        { status: 503, headers: { "Retry-After": "3600" } }
      );
    }
    const message = err instanceof Error ? err.message : "screen failed";
    return NextResponse.json({ error: "screen_failed", message }, { status: 502 });
  }
}

export async function GET(req: Request) {
  return handle(new URL(req.url).searchParams.get("address"), req);
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { address?: string };
  return handle(body.address ?? null, req);
}

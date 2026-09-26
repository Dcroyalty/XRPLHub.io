// GET /api/monitor/history?subject=r...&limit=50&before=<ISO>
// The attested time series for one wallet this key watches (or has watched): sparse observations —
// baseline / change / event / weekly heartbeat — each with its leaf hash and, once the daily Merkle
// anchor has run, the on-ledger anchor. History shows OBSERVATION POINTS, not proof of continuous
// coverage; `watching.lastCheckedAt` says when we last actually looked.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { recogniseAddress } from "@/lib/chainAddress";
import { authKey, err } from "@/lib/monitorApi";
import { MONITOR_DISCLAIMER } from "@/lib/monitorCanon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await authKey(req);
  if (!auth.ok) return auth.res;
  const key = auth.key;
  const url = new URL(req.url);
  const subjectRec = recogniseAddress((url.searchParams.get("subject") ?? "").trim());
  if (!subjectRec) return err(400, "bad_request", "Provide a valid address on a supported chain (XRPL r-address, EVM 0x, Bitcoin, Tron): ?subject=...");
  const subject = subjectRec.normalized;
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
  const beforeRaw = url.searchParams.get("before");
  const before = beforeRaw ? new Date(beforeRaw) : null;
  if (before && Number.isNaN(before.getTime())) return err(400, "bad_request", "before must be an ISO timestamp.");

  const watching = await prisma.monitorSubject.findFirst({ where: { address: subject, subscription: { apiKeyId: key.id, status: { not: "deleted" } } } });
  const rows = await prisma.monitorObservation.findMany({
    where: { apiKeyId: key.id, subject, ...(before ? { createdAt: { lt: before } } : {}) },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { anchor: true },
  });
  if (!watching && rows.length === 0) return err(404, "not_watched", "This key does not watch that wallet and has no history for it. Subscribe with POST /api/monitor/subscribe.");

  return NextResponse.json(
    {
      subject,
      watching: watching
        ? { lastCheckedAt: watching.lastCheckedAt ? watching.lastCheckedAt.toISOString() : null, nextCheckAt: watching.nextCheckAt.toISOString(), consecutiveFailedChecks: watching.consecutiveFailures }
        : null,
      coverage: "Sparse: an observation is written on subscription, on any change in account state / score / sanctions / loans, on any event, and at most weekly when nothing changed.",
      observations: rows.map((o) => {
        const leaf = o.recordJson as Record<string, unknown>;
        return {
          observationId: o.observationId,
          kind: o.kind,
          observedAt: leaf.generatedAt,
          ledgerIndex: o.ledgerIndex,
          accountStatus: leaf.accountStatus,
          xrplScore: leaf.xrplScore,
          scoreStatus: leaf.scoreStatus,
          scoreObservationRef: leaf.scoreObservationRef,
          methodology: leaf.methodology,
          sanctions: leaf.sanctions,
          loans: leaf.loans,
          eventTypes: leaf.eventTypes,
          leafHash: o.leafHash,
          anchor: o.anchor
            ? { status: o.anchor.status, txHash: o.anchor.txHash, ledgerIndex: o.anchor.ledgerIndex, merkleRoot: o.anchor.merkleRoot, anchoredAt: o.anchor.anchoredAt ? o.anchor.anchoredAt.toISOString() : null }
            : { status: "pending" },
          verify: `https://www.xrplhub.io/api/attest/verify?queryId=${o.observationId}`,
        };
      }),
      next: rows.length === limit ? rows[rows.length - 1].createdAt.toISOString() : null,
      disclaimer: MONITOR_DISCLAIMER,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

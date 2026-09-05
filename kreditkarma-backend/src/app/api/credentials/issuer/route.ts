// src/app/api/credentials/issuer/route.ts
// GET /api/credentials/issuer?address=r... — everything an issuer has issued:
// types, subject count, acceptance rate. Free, no signup.
//
// Served from the census index (src/lib/credentialIndexer.ts), not live —
// staleness here is fine (aggregate stats, not a trust decision made in the
// moment). What is NOT fine is presenting an incomplete walk as a finished
// census: if the indexer has never completed a full pass, `coverage` says
// "partial" and the numbers are labeled as such, never silently offered as
// the whole picture.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { isValidXrplAddress } from "@/lib/engine";
import { convertHexToString } from "xrpl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeDecode(hex: string): string {
  try {
    return convertHexToString(hex);
  } catch {
    return hex;
  }
}

function rippleToISO(ripple: number): string {
  return new Date((ripple + 946_684_800) * 1000).toISOString();
}

export async function GET(req: Request) {
  const address = new URL(req.url).searchParams.get("address")?.trim() ?? "";
  if (!isValidXrplAddress(address)) {
    return NextResponse.json(
      { error: "bad_request", message: "Provide a valid XRPL address (&address=r...)." },
      { status: 400 }
    );
  }

  const checkpoint = await prisma.indexerCheckpoint.findUnique({ where: { id: "credential" } });
  const coverage: "complete" | "partial" = checkpoint?.lastCompletedPassAt ? "complete" : "partial";
  const nowRipple = checkpoint?.lastLedgerCloseTime ?? null;

  const rows = await prisma.indexedCredential.findMany({ where: { issuer: address } });

  const subjects = new Set(rows.map((r) => r.subject));
  const acceptedCount = rows.filter((r) => r.accepted).length;
  const typeCounts = new Map<string, number>();
  for (const r of rows) typeCounts.set(r.credentialType, (typeCounts.get(r.credentialType) ?? 0) + 1);

  return NextResponse.json({
    address,
    source: "indexed",
    coverage,
    lastCompletedPassAt: checkpoint?.lastCompletedPassAt ?? null,
    warning:
      coverage === "partial"
        ? "The census has not completed a full network pass yet. These numbers reflect only what's been " +
          "walked so far and may be missing credentials issued by this address — do not treat this as complete."
        : null,
    totalIssued: rows.length,
    subjectCount: subjects.size,
    acceptanceRate: rows.length > 0 ? Number((acceptedCount / rows.length).toFixed(4)) : null,
    types: [...typeCounts.entries()].map(([hex, count]) => ({
      credentialType: safeDecode(hex),
      credentialTypeHex: hex,
      count,
    })),
    credentials: rows.map((r) => ({
      subject: r.subject,
      credentialType: safeDecode(r.credentialType),
      credentialTypeHex: r.credentialType,
      accepted: r.accepted,
      expired: r.expirationRipple != null && nowRipple != null ? r.expirationRipple <= nowRipple : null,
      expirationISO: r.expirationRipple != null ? rippleToISO(r.expirationRipple) : null,
    })),
  });
}

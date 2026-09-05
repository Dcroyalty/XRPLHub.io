// src/app/api/mpt/search/route.ts
// GET /api/mpt/search?q=... — find MPT issuances in the registry index by
// issuer address, issuance id (or a prefix of it), or token name / ticker.
// Free, no signup. Served from the IndexedMPT index, not a live walk — the
// response carries `coverage` and `lastCompletedPassAt` and must never be
// read as the whole population before our ledger walk completes a full pass.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { isValidXrplAddress } from "@/lib/engine";
import { mptCoverage, decodeMptFlags } from "@/lib/mptIndex";
import { mptIssuanceLink, mptIssuerLink } from "@/lib/related";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

const HEX_RE = /^[0-9A-Fa-f]{4,48}$/;
const LIMIT = 50;

function shape(r: Awaited<ReturnType<typeof prisma.indexedMPT.findMany>>[number]) {
  return {
    issuanceId: r.issuanceId,
    issuer: r.issuer,
    name: r.name,
    ticker: r.ticker,
    assetScale: r.assetScale,
    maximumAmount: r.maxAmount,
    outstandingAmount: r.outstanding,
    transferFeeBps: r.transferFee / 10,
    holderCount: r.holderCount,
    issuerPowers: decodeMptFlags(r.flagsRaw),
    sources: r.sources ? r.sources.split(",") : [],
    lastSeenAt: r.lastSeenAt.toISOString(),
  };
}

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) {
    return NextResponse.json(
      { error: "bad_request", message: "Provide ?q= — an issuer address (r...), an MPTokenIssuanceID or prefix (hex), or a token name." },
      { status: 400 }
    );
  }

  let matchType: "issuer" | "issuanceId" | "name";
  let rows;
  if (isValidXrplAddress(q)) {
    matchType = "issuer";
    rows = await prisma.indexedMPT.findMany({ where: { issuer: q }, take: LIMIT, orderBy: { outstanding: "desc" } });
  } else if (HEX_RE.test(q)) {
    matchType = "issuanceId";
    const up = q.toUpperCase();
    rows =
      up.length === 48
        ? await prisma.indexedMPT.findMany({ where: { issuanceId: up }, take: LIMIT })
        : await prisma.indexedMPT.findMany({ where: { issuanceId: { startsWith: up } }, take: LIMIT });
  } else {
    matchType = "name";
    rows = await prisma.indexedMPT.findMany({
      where: { searchText: { contains: q.toLowerCase() } },
      take: LIMIT,
      orderBy: { outstanding: "desc" },
    });
  }

  const coverage = await mptCoverage(prisma);
  const related =
    rows.length === 1
      ? [mptIssuanceLink(rows[0].issuanceId), mptIssuerLink(rows[0].issuer)]
      : matchType === "issuer"
      ? [mptIssuerLink(q)]
      : [];

  return NextResponse.json({
    query: q,
    matchedBy: matchType,
    source: "indexed",
    ...coverage,
    count: rows.length,
    truncated: rows.length === LIMIT,
    results: rows.map(shape),
    related,
  });
}

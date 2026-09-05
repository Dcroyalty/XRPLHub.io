// src/app/api/mpt/issuer/route.ts
// GET /api/mpt/issuer?address=r... — everything one issuer has issued, from
// the registry index, plus the issuer's own XRPLScore. Free, no signup.
//
// The issuance list is served from IndexedMPT (fast, and carries `coverage` /
// `lastCompletedPassAt`). The issuer's XRPLScore comes from the cached
// aggregate the cron keeps fresh; if there's no cached score yet it's
// computed live on this request so the answer is never scoreless.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { isValidXrplAddress } from "@/lib/engine";
import { mptCoverage, decodeMptFlags, issuanceIdsHash } from "@/lib/mptIndex";
import { scoreWallet, AccountNotFoundError } from "@/lib/xrplscore";
import { scoreLink, mptIssuanceLink, credentialsAccountLink } from "@/lib/related";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

export async function GET(req: Request) {
  const address = new URL(req.url).searchParams.get("address")?.trim() ?? "";
  if (!isValidXrplAddress(address)) {
    return NextResponse.json(
      { error: "bad_request", message: "Provide a valid XRPL issuer address (&address=r...)." },
      { status: 400 }
    );
  }

  const [rows, agg, coverage] = await Promise.all([
    prisma.indexedMPT.findMany({ where: { issuer: address }, orderBy: { outstanding: "desc" } }),
    prisma.indexedMptIssuer.findUnique({ where: { issuer: address } }),
    mptCoverage(prisma),
  ]);

  // Cached score if the aggregate has one; otherwise compute it live now.
  let xrplScore = agg?.xrplScore ?? null;
  let grade = agg?.grade ?? null;
  let scoredAt = agg?.scoredAt ? agg.scoredAt.toISOString() : null;
  let scoreSource: "cached" | "live" | "unavailable" = agg?.xrplScore != null ? "cached" : "unavailable";
  if (xrplScore == null) {
    try {
      const s = await scoreWallet(address);
      xrplScore = s.ledgerScore;
      grade = s.grade;
      scoredAt = new Date().toISOString();
      scoreSource = "live";
    } catch (err) {
      if (!(err instanceof AccountNotFoundError)) {
        scoreSource = "unavailable";
      }
    }
  }

  const hash = issuanceIdsHash(rows.map((r) => r.issuanceId));
  const aggregateStale = !!agg && agg.issuanceIdsHash !== hash;

  const related = [scoreLink(address)];
  if (rows.length === 1) related.push(mptIssuanceLink(rows[0].issuanceId));
  related.push(credentialsAccountLink(address));

  return NextResponse.json({
    issuer: address,
    source: "indexed",
    ...coverage,
    issuer_known_to_index: rows.length > 0 || !!agg,
    aggregateStale, // the cron hasn't re-run since this issuer's set last changed
    xrplScore,
    grade,
    scoreSource,
    scoredAt,
    mptCount: rows.length,
    // Every field the anchor canonicalisation (mpt-anchor-v1) reads is exposed
    // so a third party can reproduce the Merkle root — see GET /api/mpt/anchor.
    mpts: rows.map((r) => ({
      issuanceId: r.issuanceId,
      issuer: r.issuer,
      sequence: r.sequence,
      name: r.name,
      ticker: r.ticker,
      assetScale: r.assetScale,
      maximumAmount: r.maxAmount,
      outstandingAmount: r.outstanding,
      transferFee: r.transferFee,           // raw (tenths of a basis point)
      transferFeeBps: r.transferFee / 10,
      flags: r.flagsRaw,                    // raw MPTokenIssuance Flags
      issuerPowers: decodeMptFlags(r.flagsRaw),
      metadata: r.metadata,                 // raw decoded MPTokenMetadata string (or null)
      holderCount: r.holderCount,
      sources: r.sources ? r.sources.split(",").sort() : [],
    })),
    related: related.slice(0, 3),
  });
}

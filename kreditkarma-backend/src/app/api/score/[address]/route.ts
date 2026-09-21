import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { AccountNotFoundError, XrplUnavailableError, COPYRIGHT } from '@/lib/xrplscore';
import { getScoreCached, SCORE_CACHE_TTL_MS } from '@/lib/scoreCache';
import { isValidXrplAddress } from "@/lib/address";

const prisma = new PrismaClient();

// ─── MAIN HANDLER ────────────────────────────────────────────────────────────
// Scoring lives in src/lib/xrplscore.ts (the ONE engine — site, B2B API,
// wallet report and credential all call it). This route adds the DB history
// write and the public JSON shape on top.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ address: string }> }
) {
  const { address: rawAddress } = await params;
  const address = decodeURIComponent(rawAddress);

  if (!address || !isValidXrplAddress(address)) {
    return NextResponse.json({ error: 'Invalid XRPL address format' }, { status: 400 });
  }

  try {
    // Display cache: serves a stored score up to 15 min old; on a miss it
    // computes fresh and stores it. NOT for attestations — this route is the
    // public site + free lookups.
    const { result: r, computedAt, fromCache, ageMs } = await getScoreCached(prisma, address, SCORE_CACHE_TTL_MS);

    // Score-history row only on a genuine fresh compute (don't spam it on hits).
    if (!fromCache) {
      prisma.scoreHistory.create({
        data: { address, score: r.ledgerScore, tier: r.grade, percentile: r.percentile, breakdown: JSON.stringify(r.signals) },
      }).catch(() => { /* history write failure shouldn't break the response */ });
    }

    // ── RESPONSE ─────────────────────────────────────────────────────────────
    return NextResponse.json({
      ledgerScore: r.ledgerScore,
      xrplScore: r.ledgerScore,
      grade: r.grade,
      breakdown: r.breakdown,
      signals: r.signals,
      recommendations: r.recommendations,
      percentile: r.percentile,
      percentileLabel: r.percentileLabel,
      details: r.details,
      address,
      scannedAt: computedAt,
      computedAt,
      fromCache,
      cacheAgeSeconds: Math.round(ageMs / 1000),
      methodology: r.methodology,
      disclaimer: r.disclaimer,
      dataCompleteness: r.dataCompleteness,
      copyright: COPYRIGHT,
    }, {
      headers: {
        'Cache-Control': 'no-store',
        'X-Score-Version': '1.1',
        'X-Score-Provider': 'XRPLHub',
      }
    });

  } catch (err: unknown) {
    if (err instanceof AccountNotFoundError) {
      return NextResponse.json({ error: 'Account not found on XRPL mainnet' }, { status: 404 });
    }
    if (err instanceof XrplUnavailableError) {
      // Could not read one or more XRPL calls — NOT scored. Retryable.
      return NextResponse.json(
        { error: 'xrpl_unavailable', message: err.message, failedCalls: err.failedCalls, retryable: true },
        { status: 503, headers: { 'Retry-After': '15', 'Cache-Control': 'no-store' } }
      );
    }
    const message = err instanceof Error ? err.message : 'Score computation failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

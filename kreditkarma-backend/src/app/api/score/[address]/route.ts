import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { scoreWallet, AccountNotFoundError, XrplUnavailableError, COPYRIGHT } from '@/lib/xrplscore';

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

  if (!address || !address.startsWith('r') || address.length < 25 || address.length > 35) {
    return NextResponse.json({ error: 'Invalid XRPL address format' }, { status: 400 });
  }

  try {
    const r = await scoreWallet(address);

    // ── SAVE TO DB (history + current snapshot) — fire and forget ───────────
    const breakdownJSON = JSON.stringify(r.signals);
    Promise.allSettled([
      prisma.scoreHistory.create({
        data: { address, score: r.ledgerScore, tier: r.grade, percentile: r.percentile, breakdown: breakdownJSON },
      }),
      prisma.ledgerScore.upsert({
        where:  { address },
        update: { score: r.ledgerScore, tier: r.grade, breakdown: breakdownJSON, rawData: JSON.stringify(r.details) },
        create: { address, score: r.ledgerScore, tier: r.grade, breakdown: breakdownJSON, rawData: JSON.stringify(r.details) },
      }),
    ]).catch(() => { /* DB write failure shouldn't break the score response */ });

    // ── RESPONSE (unchanged shape) ────────────────────────────────────────────
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
      scannedAt: new Date().toISOString(),
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

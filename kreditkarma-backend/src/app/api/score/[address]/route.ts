import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { scoreWallet, AccountNotFoundError, COPYRIGHT } from '@/lib/xrplscore';

const prisma = new PrismaClient();

// ─── MAIN HANDLER ────────────────────────────────────────────────────────────
// Scoring lives in src/lib/xrplscore.ts (the ONE engine — site, B2B API,
// wallet report and credential all call it). This route adds the DB history
// write and the public JSON shape on top.
export async function GET(
  _req: NextRequest,
  { params }: { params: { address: string } }
) {
  const address = decodeURIComponent(params.address);

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
    const message = err instanceof Error ? err.message : 'Score computation failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

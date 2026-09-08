import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { SCORE_DISCLAIMER } from '@/lib/xrplscore';

const prisma = new PrismaClient();

// GET /api/score/history/[address] — returns score check history for a wallet
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ address: string }> }
) {
  const { address: rawAddress } = await params;
  const address = decodeURIComponent(rawAddress);

  if (!address || !address.startsWith('r') || address.length < 25) {
    return NextResponse.json({ error: 'Invalid XRPL address' }, { status: 400 });
  }

  try {
    const history = await prisma.scoreHistory.findMany({
      where: { address },
      orderBy: { checkedAt: 'asc' },
      take: 50,
      select: {
        score: true,
        tier: true,
        percentile: true,
        checkedAt: true,
      },
    });

    // Compute trend
    let trend: 'up' | 'down' | 'flat' | 'new' = 'new';
    let change = 0;
    if (history.length >= 2) {
      const first = history[0].score;
      const last  = history[history.length - 1].score;
      change = last - first;
      trend = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
    }

    return NextResponse.json({
      address,
      checkCount: history.length,
      history: history.map(h => ({
        score: h.score,
        tier: h.tier,
        percentile: h.percentile,
        date: h.checkedAt.toISOString(),
      })),
      trend,
      change,
      firstScore: history[0]?.score ?? null,
      latestScore: history[history.length - 1]?.score ?? null,
      disclaimer: SCORE_DISCLAIMER,
    }, {
      headers: { 'Cache-Control': 'no-store' }
    });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'History fetch failed';
    return NextResponse.json({ error: message, history: [], checkCount: 0 }, { status: 500 });
  }
}

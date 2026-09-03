import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { isAdmin } from '@/lib/adminAuth';

const prisma = new PrismaClient();
const TREASURY = 'rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF';
const XRPL_API = 'https://xrplcluster.com';

async function getTreasuryBalance(): Promise<number> {
  try {
    const res = await fetch(XRPL_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'account_info',
        params: [{ account: TREASURY, ledger_index: 'validated' }],
      }),
    });
    const json = await res.json();
    const drops = json?.result?.account_data?.Balance;
    return drops ? Number(drops) / 1_000_000 : 0;
  } catch {
    return 0;
  }
}

async function getXRPPrice(): Promise<number> {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ripple&vs_currencies=usd');
    const json = await res.json();
    return json?.ripple?.usd || 0.5;
  } catch {
    return 0.5;
  }
}

// GET /api/admin — full live admin dashboard data (admin token required)
export async function GET(req: Request) {
  if (!isAdmin(req)) {
    return NextResponse.json(
      { error: 'unauthorized', message: 'Valid admin token required.' },
      { status: 401 }
    );
  }
  try {
    const [
      treasuryXRP,
      xrpPrice,
      grants,
      grantStats,
      scoreCount,
      recentScores,
      donations,
      donationSum,
    ] = await Promise.all([
      getTreasuryBalance(),
      getXRPPrice(),
      // Recent grant applications
      prisma.grantRequest.findMany({
        orderBy: { createdAt: 'desc' },
        take: 50,
      }).catch(() => []),
      // Grant counts by status
      prisma.grantRequest.groupBy({
        by: ['status'],
        _count: { status: true },
      }).catch(() => []),
      // Total score checks
      prisma.scoreHistory.count().catch(() => 0),
      // Recent score checks
      prisma.scoreHistory.findMany({
        orderBy: { checkedAt: 'desc' },
        take: 25,
        select: { address: true, score: true, tier: true, checkedAt: true },
      }).catch(() => []),
      // Recent donations
      prisma.donation.findMany({
        orderBy: { createdAt: 'desc' },
        take: 25,
      }).catch(() => []),
      // Total donated
      prisma.donation.aggregate({
        _sum: { amount: true },
      }).catch(() => ({ _sum: { amount: 0 } })),
    ]);

    // Build status breakdown
    const statusCounts: Record<string, number> = {
      PENDING: 0, REVIEWING: 0, APPROVED: 0, REJECTED: 0, PAID: 0, FAILED: 0,
    };
    for (const g of grantStats as { status: string; _count: { status: number } }[]) {
      statusCounts[g.status] = g._count.status;
    }

    const totalGrants     = (grants as unknown[]).length;
    const treasuryUSD     = treasuryXRP * xrpPrice;
    const totalDonatedXRP = donationSum?._sum?.amount || 0;

    return NextResponse.json({
      // Treasury
      treasury: {
        address: TREASURY,
        balanceXRP: Math.round(treasuryXRP * 100) / 100,
        balanceUSD: Math.round(treasuryUSD * 100) / 100,
        xrpPrice,
      },
      // Grants
      grants: {
        total: totalGrants,
        byStatus: statusCounts,
        pending: statusCounts.PENDING + statusCounts.REVIEWING,
        recent: grants,
      },
      // Scores
      scores: {
        totalChecks: scoreCount,
        recent: recentScores,
      },
      // Donations
      donations: {
        count: (donations as unknown[]).length,
        totalXRP: Math.round(totalDonatedXRP * 100) / 100,
        recent: donations,
      },
      // Meta
      updatedAt: new Date().toISOString(),
    }, {
      headers: { 'Cache-Control': 'no-store' }
    });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Admin data fetch failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

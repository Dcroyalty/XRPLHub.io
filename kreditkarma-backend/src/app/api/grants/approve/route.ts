// src/app/api/grants/approve/route.ts
// Manual final approval (you). Locked behind ADMIN_API_TOKEN (header only).
// Matches LIVE Neon columns: txHash (NOT payoutTx), paidAt (NOT reviewedAt).

import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { isAdmin } from '@/lib/adminAuth';

const prisma = new PrismaClient();

export async function POST(req: Request) {
  if (!isAdmin(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const { id, action, txHash, approvedAmount, rejectionReason } = body || {};

    if (!id || !action) {
      return NextResponse.json({ error: 'id and action are required' }, { status: 400 });
    }

    const statusMap: Record<string, string> = {
      APPROVE: 'APPROVED', REJECT: 'REJECTED', DENY: 'REJECTED', PAID: 'PAID', FAIL: 'FAILED',
    };
    // ACCEPT_PAYOUT: make the applicant's proposed payout details (from /grants/status) the real ones. Status unchanged.
    if (String(action).toUpperCase() === 'ACCEPT_PAYOUT') {
      const g = await prisma.grantRequest.findUnique({ where: { id: String(id) } });
      if (!g?.proposedAt) return NextResponse.json({ error: 'no proposed payout details' }, { status: 400 });
      await prisma.grantRequest.update({
        where: { id: g.id },
        data: { payoutAddress: g.proposedPayoutAddress, payoutTag: g.proposedPayoutTag, proposedPayoutAddress: null, proposedPayoutTag: null, proposedAt: null },
      });
      return NextResponse.json({ ok: true, id: g.id, status: g.status });
    }
    const newStatus = statusMap[String(action).toUpperCase()];
    if (!newStatus) {
      return NextResponse.json({ error: 'invalid action' }, { status: 400 });
    }

    const data: Record<string, unknown> = { status: newStatus };
    if (newStatus === 'PAID' && txHash) {
      data.txHash  = String(txHash);
      data.paidAt  = new Date();
      if (approvedAmount !== undefined) data.paidAmount = Number(approvedAmount);
    }
    if (newStatus === 'APPROVED' && approvedAmount !== undefined) {
      data.approvedAmount = Number(approvedAmount);
    }
    if (newStatus === 'REJECTED' && rejectionReason) {
      data.rejectionReason = String(rejectionReason);
    }

    const grant = await prisma.grantRequest.update({ where: { id: String(id) }, data });
    return NextResponse.json({ ok: true, id: grant.id, status: grant.status });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'approve failed';
    console.error('[grants/approve]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

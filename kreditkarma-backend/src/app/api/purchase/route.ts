// src/app/api/purchase/route.ts
// POST: record a verified purchase. GET: list purchases for ?email= or ?wallet=
// The /account dashboard reads from this.

import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { isAdmin } from '@/lib/adminAuth';

const prisma = new PrismaClient();

// POST writes/updates purchase rows. Nothing on the request path calls this
// anymore (see src/lib/recordPurchase.ts — direct DB write, no HTTP hop), so
// an open POST here only lets an attacker forge "delivered" purchase records.
// Admin token required.
export async function POST(req: NextRequest) {
  if (!isAdmin(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    const b = await req.json().catch(() => ({}));
    const {
      productId, currency, amount, email, txHash, sender,
      serviceTxHash, status, verifiedAt, deliveredAt,
    } = b || {};

    if (!txHash && !serviceTxHash) {
      return NextResponse.json({ error: 'tx hash required' }, { status: 400 });
    }

    // If we already have a row keyed on the payment txHash, update it (this is the second
    // call from execute/verify upgrading the row to DELIVERED with the service tx).
    if (txHash) {
      const existing = await prisma.purchase.findFirst({ where: { txHash } }).catch(() => null);
      if (existing) {
        const updated = await prisma.purchase.update({
          where: { id: existing.id },
          data: {
            serviceTxHash: serviceTxHash || existing.serviceTxHash,
            status: status || existing.status,
            deliveredAt: deliveredAt ? new Date(deliveredAt) : existing.deliveredAt,
          },
        });
        return NextResponse.json({ ok: true, id: updated.id });
      }
    }

    const row = await prisma.purchase.create({
      data: {
        productId: String(productId || ''),
        currency:  String(currency  || 'XRP'),
        amount:    String(amount    || '0'),
        email:     email || null,
        wallet:    sender || null,
        txHash:    txHash || null,
        serviceTxHash: serviceTxHash || null,
        status:    status || 'VERIFIED',
        verifiedAt:  verifiedAt  ? new Date(verifiedAt)  : new Date(),
        deliveredAt: deliveredAt ? new Date(deliveredAt) : null,
      },
    });
    return NextResponse.json({ ok: true, id: row.id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'purchase write failed';
    console.error('[purchase POST]', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const email  = req.nextUrl.searchParams.get('email')  || '';
    const wallet = req.nextUrl.searchParams.get('wallet') || '';
    // Require BOTH identifiers and match them on the same row. A single known
    // email or wallet is no longer enough to enumerate a customer's purchases.
    // (Admin token also grants access, for the ops dashboard.)
    const where: Record<string, unknown> = {};
    if (isAdmin(req)) {
      if (email)  where.email  = email;
      if (wallet) where.wallet = wallet;
    } else if (email && wallet) {
      where.AND = [{ email }, { wallet }];
    } else {
      return NextResponse.json([]);
    }

    const rows = await prisma.purchase.findMany({
      where, orderBy: { verifiedAt: 'desc' }, take: 100,
    });
    return NextResponse.json(rows);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'purchase read failed';
    console.error('[purchase GET]', msg);
    return NextResponse.json([], { status: 200 }); // graceful empty
  }
}

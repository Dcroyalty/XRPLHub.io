// src/app/api/grants/submit/route.ts
// Persist a new grant application. Columns match LIVE Neon schema exactly.

import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { GRANT_APPLICATIONS_OPEN, GRANTS_PAUSED_MESSAGE } from '@/lib/grantsStatus';
import { isValidXrplAddress } from "@/lib/address";

const prisma = new PrismaClient();

// Map our form's free-text category to a simple urgency tier
const urgencyFor = (cat: string): string => {
  const c = (cat || '').toLowerCase();
  if (c.includes('medical') || c.includes('rent') || c.includes('housing')) return 'HIGH';
  if (c.includes('food') || c.includes('utilities')) return 'MEDIUM';
  return 'NORMAL';
};

export async function POST(req: Request) {
  // Applications are paused (src/lib/grantsStatus.ts). Enforced here, not just in the UI, so posting
  // to this endpoint directly can't add to the queue either.
  if (!GRANT_APPLICATIONS_OPEN) {
    return NextResponse.json({ error: 'grant_applications_paused', message: GRANTS_PAUSED_MESSAGE }, { status: 503 });
  }
  try {
    const body = await req.json().catch(() => ({}));
    // The frontend still sends these field names — we map them to DB columns here.
    const { name, wallet, email, phone, category, need, amount, currency } = body || {};

    if (!wallet || !need || !category) {
      return NextResponse.json({ error: 'wallet, category, and need are required' }, { status: 400 });
    }
    if (!isValidXrplAddress(String(wallet))) {
      return NextResponse.json({ error: 'invalid XRPL wallet' }, { status: 400 });
    }

    const amt = Math.max(0, Math.min(100, Number(amount) || 0));

    // Fold name/email/phone into description so we don't lose them (no columns for them).
    const contactBlock = [
      name && name !== 'Anonymous' ? `Name: ${name}` : null,
      email ? `Email: ${email}` : null,
      phone ? `Phone: ${phone}` : null,
    ].filter(Boolean).join(' · ');
    const description = contactBlock ? `${need}\n\n— ${contactBlock}` : need;

    const grant = await prisma.grantRequest.create({
      data: {
        walletAddress:   String(wallet),
        category:        String(category),
        amountRequested: amt,
        currency:        String(currency || 'RLUSD'),
        description,
        urgency:         urgencyFor(category),
        status:          'PENDING',
      },
    });

    return NextResponse.json({ ok: true, id: grant.id, status: grant.status });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'submit failed';
    console.error('[grants/submit]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

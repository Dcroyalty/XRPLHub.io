// src/app/api/grants/submit/route.ts — save a grant application (free; there is never a fee to apply).
//
// Applications to the grants pool (round "pool-2026", src/lib/grantsPool.ts) are saved and reviewed in order once
// the pool reaches its first milestone; we email the applicant when review starts. No timeline is promised before
// that. The applicant's email is kept only for that (and the decision); marketing updates are a separate opt-in
// after applying (/api/grants/updates).
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/xrplscore-db';
import { GRANT_APPLICATIONS_OPEN, GRANTS_PAUSED_MESSAGE } from '@/lib/grantsStatus';
import { APPLICANT_STATUS, GRANT_CATEGORIES } from '@/lib/grantsPool';
import { isValidXrplAddress } from '@/lib/address';
import { rateLimit, rateLimited } from '@/lib/rateLimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;


const urgencyFor = (cat: string): string => {
  const c = cat.toLowerCase();
  if (c.includes('medical') || c.includes('rent')) return 'HIGH';
  if (c.includes('food') || c.includes('utilities')) return 'MEDIUM';
  return 'NORMAL';
};

export async function POST(req: Request) {
  if (!GRANT_APPLICATIONS_OPEN) {
    return NextResponse.json({ error: 'grant_applications_paused', message: GRANTS_PAUSED_MESSAGE }, { status: 503 });
  }
  const rl = rateLimit(req, 'grants-submit', 3, 60 * 60_000);
  if (!rl.ok) return rateLimited(rl);
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof b.website === 'string' && b.website.trim()) return NextResponse.json({ ok: true, status: APPLICANT_STATUS }); // honeypot
  const wallet = String(b.wallet ?? '').trim();
  const email = String(b.email ?? '').trim().toLowerCase();
  const category = String(b.category ?? '');
  const need = String(b.need ?? '').trim();
  const name = String(b.name ?? '').trim().slice(0, 80);
  const amount = Math.round(Number(b.amountXrp));
  if (!isValidXrplAddress(wallet)) return NextResponse.json({ error: 'Enter a valid XRP Ledger address (starts with r).' }, { status: 400 });
  if (email.length > 254 || !EMAIL.test(email)) return NextResponse.json({ error: 'Enter an email address — we use it to tell you when review starts.' }, { status: 400 });
  if (!GRANT_CATEGORIES.includes(category)) return NextResponse.json({ error: 'Choose what the grant is for.' }, { status: 400 });
  if (need.length < 20 || need.length > 2000) return NextResponse.json({ error: 'Tell us what you need in 20 to 2,000 characters.' }, { status: 400 });
  if (!Number.isFinite(amount) || amount < 10 || amount > 100) return NextResponse.json({ error: 'Ask for 10 to 100 XRP.' }, { status: 400 });

  // One open application per wallet in this round.
  const existing = await prisma.grantRequest.findFirst({ where: { walletAddress: wallet, round: 'pool-2026', status: { in: ['PENDING', 'REVIEWING', 'APPROVED'] } }, select: { id: true } });
  if (existing) return NextResponse.json({ ok: true, id: existing.id, status: APPLICANT_STATUS, duplicate: true });

  const grant = await prisma.grantRequest.create({
    data: {
      walletAddress: wallet,
      category,
      amountRequested: amount,
      currency: 'XRP',
      description: name ? `${need}\n\n— Name: ${name}` : need,
      urgency: urgencyFor(category),
      status: 'PENDING',
      round: 'pool-2026',
      email,
    },
    select: { id: true },
  });
  return NextResponse.json({ ok: true, id: grant.id, status: APPLICANT_STATUS }, { headers: { 'Cache-Control': 'no-store' } });
}

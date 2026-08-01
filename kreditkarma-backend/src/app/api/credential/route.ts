// src/app/api/credential/route.ts
// PAID VERIFIABLE SCORE CREDENTIAL
// The score lookup stays free forever. What's paid here is the *attestation*:
// a signed, tamper-evident, independently verifiable certificate that wallet X
// held score Y on date Z. A free number is unprovable to a third party;
// a signed credential is. That's the product.
//
// POST /api/credential            -> create payment, return Xaman payload
// POST /api/credential?claim=1    -> after payment, verify + issue signed cert
// GET  /api/credential?certId=... -> public verification (see verify/route.ts)

import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://www.xrplhub.io';

// Signing secret. MUST be set in Vercel env for signatures to be meaningful.
// Falls back only so local dev doesn't crash — flagged in the response.
const SIGNING_SECRET = process.env.CREDENTIAL_SIGNING_SECRET || '';

// Price: deliberately low. This is a volume/positioning play, not a margin play.
const PRICE = { XRP: '1', RLUSD: '1' } as const;
const VALIDITY_DAYS = 90;

type Currency = keyof typeof PRICE;

function signPayload(data: Record<string, unknown>): string {
  const canonical = JSON.stringify(data, Object.keys(data).sort());
  if (!SIGNING_SECRET) return 'UNSIGNED-DEV-' + crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
  return crypto.createHmac('sha256', SIGNING_SECRET).update(canonical).digest('hex');
}

function makeCertId(): string {
  // Human-quotable, collision-resistant: XRPLS-A1B2-C3D4-E5F6
  const raw = crypto.randomBytes(6).toString('hex').toUpperCase();
  return `XRPLS-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

export async function POST(req: NextRequest) {
  try {
    const isClaim = req.nextUrl.searchParams.get('claim') === '1';
    const body = await req.json().catch(() => ({}));
    const wallet = String(body.wallet_address || body.wallet || '').trim();
    const currency: Currency = body.currency === 'RLUSD' ? 'RLUSD' : 'XRP';

    if (!wallet.startsWith('r') || wallet.length < 25 || wallet.length > 35) {
      return NextResponse.json({ error: 'Valid XRPL wallet address required (starts with r).' }, { status: 400 });
    }

    // ── STEP 2: claim — payment was made, verify it and issue the credential ──
    if (isClaim) {
      const uuid = String(body.uuid || '').trim();
      if (!uuid) return NextResponse.json({ error: 'Missing payment uuid.' }, { status: 400 });

      // Verify the payment actually settled, using the existing proven route.
      const params = new URLSearchParams({ uuid, productId: 'credential', amount: PRICE[currency], currency });
      const payRes = await fetch(`${API_URL}/api/check-payment?${params}`, { signal: AbortSignal.timeout(10_000) });
      const payData = await payRes.json().catch(() => ({}));

      if (payData.status !== 'verified') {
        return NextResponse.json(
          { error: 'Payment not verified yet.', status: payData.status || 'unknown' },
          { status: 402 }
        );
      }

      // Idempotency: if this tx already issued a credential, return it rather than double-charging.
      if (payData.txHash) {
        const existing = await prisma.scoreCredential.findUnique({ where: { txHash: payData.txHash } });
        if (existing) {
          return NextResponse.json({
            success: true,
            alreadyIssued: true,
            certId: existing.certId,
            verifyUrl: `${API_URL}/verify/${existing.certId}`,
          });
        }
      }

      // Pull the live score at issuance time. The credential attests to this moment.
      const scoreRes = await fetch(`${API_URL}/api/score/${wallet}`, { signal: AbortSignal.timeout(15_000) });
      if (!scoreRes.ok) {
        return NextResponse.json({ error: 'Could not compute score for this wallet right now.' }, { status: 502 });
      }
      const scoreData = await scoreRes.json();
      const score = Number(scoreData.score ?? scoreData.ledgerScore ?? 0);
      const grade = String(scoreData.grade ?? scoreData.rating ?? 'Unrated');
      const percentile = scoreData.percentile != null ? Number(scoreData.percentile) : null;

      if (!score || score < 300 || score > 850) {
        return NextResponse.json({ error: 'Score unavailable or out of range for this wallet.' }, { status: 502 });
      }

      const certId = makeCertId();
      const issuedAt = new Date();
      const expiresAt = new Date(issuedAt.getTime() + VALIDITY_DAYS * 86_400_000);

      // The signature covers exactly the claims a third party will rely on.
      const signature = signPayload({
        certId, wallet, score, grade,
        issuedAt: issuedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });

      const cred = await prisma.scoreCredential.create({
        data: {
          certId,
          walletAddress: wallet,
          score,
          grade,
          percentile,
          signature,
          issuedAt,
          expiresAt,
          amountPaid: PRICE[currency],
          currency,
          txHash: payData.txHash || null,
          paymentUuid: uuid,
          status: 'ISSUED',
        },
      });

      return NextResponse.json({
        success: true,
        certId: cred.certId,
        wallet,
        score,
        grade,
        percentile,
        issuedAt: issuedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        signature,
        verifyUrl: `${API_URL}/verify/${cred.certId}`,
        signedProperly: Boolean(SIGNING_SECRET),
        note: SIGNING_SECRET
          ? 'This credential is cryptographically signed and independently verifiable at the verifyUrl.'
          : 'WARNING: CREDENTIAL_SIGNING_SECRET is not set in the environment — this credential is not cryptographically binding.',
      });
    }

    // ── STEP 1: create the payment request ──────────────────────────────────
    const payRes = await fetch(`${API_URL}/api/create-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: 'credential', currency, amount: PRICE[currency] }),
      signal: AbortSignal.timeout(12_000),
    });
    const payData = await payRes.json().catch(() => ({}));

    if (!payRes.ok || !payData.uuid) {
      return NextResponse.json(
        { error: payData.error || 'Could not create payment request.' },
        { status: 502 }
      );
    }

    return NextResponse.json({
      step: 'awaiting_payment',
      wallet,
      price: `${PRICE[currency]} ${currency}`,
      uuid: payData.uuid,
      qr_png: payData.qr_png,
      deep_link: payData.deep_link,
      expires_in: payData.expires_in || 900,
      nextStep: `After signing, POST to /api/credential?claim=1 with { wallet_address, uuid, currency } to receive the signed credential.`,
    });
  } catch (err) {
    console.error('[credential]', err);
    return NextResponse.json({ error: 'Credential service error.' }, { status: 500 });
  }
}

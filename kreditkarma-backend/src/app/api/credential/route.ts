// src/app/api/credential/route.ts
// PAID VERIFIABLE SCORE CREDENTIAL
// The score lookup stays free. What's paid here is the *certificate*: a record, signed by XRPLHub, that wallet X
// held score Y on date Z. The score is computed FRESH at issuance (scoreWallet() directly) — never taken from the
// 15-minute display cache behind /api/score.
//
// WHAT THE SIGNATURE IS: an HMAC-SHA256 under CREDENTIAL_SIGNING_SECRET, a key only XRPLHub holds. So a certificate
// is verified by asking XRPLHub (GET /api/credential/verify): it confirms the record is genuine and unaltered in
// XRPLHub's own records. A third party CANNOT check the signature themselves and must trust XRPLHub to do it — this is
// a self-attestation, not an independently verifiable proof. (The on-ledger XLS-70 credential is the independently
// verifiable form.) The buyer is not required to control the wallet the certificate names.
//
// POST /api/credential            -> create payment, return Xaman payload
// POST /api/credential?claim=1    -> after payment, verify + issue signed cert
// GET  /api/credential?certId=... -> public verification (see verify/route.ts)

import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { scoreWallet, AccountNotFoundError, XrplUnavailableError } from '@/lib/xrplscore';
import { isValidXrplAddress } from "@/lib/address";

const prisma = new PrismaClient();

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://www.xrplhub.io';

// Signing secret. Without it nothing is issued (and nothing is sold): an unsigned certificate is worth nothing,
// so the route fails CLOSED rather than issuing one.
const SIGNING_SECRET = process.env.CREDENTIAL_SIGNING_SECRET || '';

// Price: deliberately low. This is a volume/positioning play, not a margin play.
const PRICE = { XRP: '1', RLUSD: '1' } as const;
const VALIDITY_DAYS = 90;

type Currency = keyof typeof PRICE;

function signPayload(data: Record<string, unknown>): string {
  const canonical = JSON.stringify(data, Object.keys(data).sort());
  return crypto.createHmac('sha256', SIGNING_SECRET).update(canonical).digest('hex');
}

function makeCertId(): string {
  // Human-quotable, collision-resistant: XRPLS-A1B2-C3D4-E5F6
  const raw = crypto.randomBytes(6).toString('hex').toUpperCase();
  return `XRPLS-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

export async function POST(req: NextRequest) {
  if (!SIGNING_SECRET) {
    return NextResponse.json(
      { error: 'credential_signing_unavailable', message: 'Certificates cannot be issued right now (signing key not configured). Nothing was charged.' },
      { status: 503 }
    );
  }
  try {
    const isClaim = req.nextUrl.searchParams.get('claim') === '1';
    const body = await req.json().catch(() => ({}));
    const wallet = String(body.wallet_address || body.wallet || '').trim();
    const currency: Currency = body.currency === 'RLUSD' ? 'RLUSD' : 'XRP';

    if (!isValidXrplAddress(wallet)) {
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

      // Compute the score FRESH, right now, straight from the scoring engine. NOT via /api/score: that route serves a
      // stored result up to 15 minutes old, and a signed certificate must attest to the moment it is issued.
      // (scripts/check-attestation-freshness.mjs enforces this for this file.)
      let fresh;
      try {
        fresh = await scoreWallet(wallet);
      } catch (e) {
        if (e instanceof AccountNotFoundError) {
          return NextResponse.json({ error: 'That wallet is not an activated account on XRPL mainnet.' }, { status: 404 });
        }
        if (e instanceof XrplUnavailableError) {
          // Paid but not yet issued: the claim is idempotent on the payment, so the buyer simply retries.
          return NextResponse.json({ error: 'xrpl_unavailable', message: 'The ledger could not be read completely, so no score was produced. Your payment is kept — retry the claim shortly.', retryable: true }, { status: 503 });
        }
        throw e;
      }
      const score = Number(fresh.ledgerScore);
      const grade = String(fresh.grade ?? 'Unrated');
      const percentile = fresh.percentile != null ? Number(fresh.percentile) : null;

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
        scoreComputedAt: issuedAt.toISOString(),
        independentlyVerifiable: false,
        note: 'Signed by XRPLHub. Anyone can ask XRPLHub to confirm it at the verifyUrl, but the signature is an HMAC under a key only XRPLHub holds — a third party has to trust XRPLHub to check it. It records the score computed at issuance for the wallet named; it does not prove the buyer controls that wallet, and it is not financial advice or a guarantee of future conduct.',
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

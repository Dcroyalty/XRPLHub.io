// src/app/api/credential/verify/route.ts
// PUBLIC, FREE, UNAUTHENTICATED credential verification.
// This endpoint is the entire reason the credential has value: a third party
// (lender, counterparty, agent) can independently confirm a certificate is
// authentic and unaltered. Deliberately free and CORS-open — verification
// friction would destroy the product.
//
// GET /api/credential/verify?certId=XRPLS-XXXX-XXXX-XXXX

import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();
const SIGNING_SECRET = process.env.CREDENTIAL_SIGNING_SECRET || '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function signPayload(data: Record<string, unknown>): string {
  const canonical = JSON.stringify(data, Object.keys(data).sort());
  if (!SIGNING_SECRET) return 'UNSIGNED-DEV-' + crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
  return crypto.createHmac('sha256', SIGNING_SECRET).update(canonical).digest('hex');
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 200, headers: CORS });
}

export async function GET(req: NextRequest) {
  try {
    const certId = String(req.nextUrl.searchParams.get('certId') || '').trim().toUpperCase();
    if (!certId) {
      return NextResponse.json({ valid: false, reason: 'No certId supplied.' }, { status: 400, headers: CORS });
    }

    const cred = await prisma.scoreCredential.findUnique({ where: { certId } });
    if (!cred || cred.status !== 'ISSUED') {
      return NextResponse.json(
        { valid: false, certId, reason: 'No issued credential found with this ID.' },
        { headers: CORS }
      );
    }

    // Recompute the signature over the stored claims. If anything in the
    // record was altered after issuance, this will not match.
    const expected = signPayload({
      certId: cred.certId,
      wallet: cred.walletAddress,
      score: cred.score,
      grade: cred.grade,
      issuedAt: cred.issuedAt.toISOString(),
      expiresAt: cred.expiresAt.toISOString(),
    });

    const signatureValid =
      expected.length === cred.signature.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(cred.signature));

    const expired = cred.expiresAt.getTime() < Date.now();
    const valid = signatureValid && !expired && !cred.revoked;

    // Track verification interest — this is the metric that tells you whether
    // anyone actually consumes these credentials.
    prisma.scoreCredential
      .update({ where: { certId }, data: { verifyCount: { increment: 1 } } })
      .catch(() => {});

    return NextResponse.json(
      {
        valid,
        certId: cred.certId,
        wallet: cred.walletAddress,
        score: cred.score,
        grade: cred.grade,
        percentile: cred.percentile,
        issuedAt: cred.issuedAt.toISOString(),
        expiresAt: cred.expiresAt.toISOString(),
        expired,
        revoked: cred.revoked,
        signatureValid,
        paymentTx: cred.txHash ? `https://xrpscan.com/tx/${cred.txHash}` : null,
        issuer: 'XRPLHub.io — XRPLScore Verified Credential',
        reason: valid
          ? 'Credential is authentic, unaltered, and current.'
          : cred.revoked ? 'Credential has been revoked.'
          : expired ? 'Credential is authentic but past its validity window.'
          : 'Signature mismatch — this credential does not match its issued record.',
        cryptographicallyBinding: Boolean(SIGNING_SECRET),
      },
      { headers: CORS }
    );
  } catch (err) {
    console.error('[credential/verify]', err);
    return NextResponse.json({ valid: false, reason: 'Verification service error.' }, { status: 500, headers: CORS });
  }
}

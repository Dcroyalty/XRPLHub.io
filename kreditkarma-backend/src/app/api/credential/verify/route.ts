// src/app/api/credential/verify/route.ts
// PUBLIC, FREE, UNAUTHENTICATED check of a certificate issued by /api/credential.
//
// WHAT THIS PROVES, AND WHAT IT DOES NOT: it recomputes an HMAC over the stored claims with XRPLHub's own signing key
// and compares it with the stored signature. A "valid" answer therefore means "this is a certificate XRPLHub issued and
// its record is unaltered" — asserted BY XRPLHUB, about XRPLHub's own records. It is a self-attestation: a third party
// cannot check the signature without asking us and trusting the answer (the key is never shared). The independently
// verifiable form is the on-ledger XLS-70 credential (/api/credentials/verify).
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

const DISCLAIMER =
  'This confirms only that XRPLHub issued this certificate and that its record is unaltered in XRPLHub\'s own records — the signature is an HMAC under a key only XRPLHub holds, so it is not independently verifiable by third parties. ' +
  'The certificate records a score computed at issuance for the wallet named; the buyer was not required to control that wallet. It is not financial, legal or compliance advice, not a credit rating, and not a guarantee of any future conduct. No warranty.';

function signPayload(data: Record<string, unknown>): string {
  const canonical = JSON.stringify(data, Object.keys(data).sort());
  return crypto.createHmac('sha256', SIGNING_SECRET).update(canonical).digest('hex');
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 200, headers: CORS });
}

export async function GET(req: NextRequest) {
  try {
    if (!SIGNING_SECRET) {
      // Never report "valid" from a check that has no key: an unsigned comparison proves nothing.
      return NextResponse.json({ valid: null, reason: 'Verification is unavailable right now (signing key not configured).', disclaimer: DISCLAIMER }, { status: 503, headers: CORS });
    }
    const certId = String(req.nextUrl.searchParams.get('certId') || '').trim().toUpperCase();
    if (!certId) {
      return NextResponse.json({ valid: false, reason: 'No certId supplied.', disclaimer: DISCLAIMER }, { status: 400, headers: CORS });
    }

    const cred = await prisma.scoreCredential.findUnique({ where: { certId } });
    if (!cred || cred.status !== 'ISSUED') {
      return NextResponse.json(
        { valid: false, certId, reason: 'No issued credential found with this ID.', disclaimer: DISCLAIMER },
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
          ? 'XRPLHub issued this certificate and its record is unaltered and current.'
          : cred.revoked ? 'Credential has been revoked.'
          : expired ? 'Issued by XRPLHub and unaltered, but past its validity window.'
          : 'Signature mismatch — this credential does not match its issued record.',
        verifiedBy: 'XRPLHub (HMAC under a key only XRPLHub holds)',
        independentlyVerifiable: false,
        disclaimer: DISCLAIMER,
      },
      { headers: CORS }
    );
  } catch (err) {
    console.error('[credential/verify]', err);
    return NextResponse.json({ valid: null, reason: 'Verification service error.', disclaimer: DISCLAIMER }, { status: 500, headers: CORS });
  }
}

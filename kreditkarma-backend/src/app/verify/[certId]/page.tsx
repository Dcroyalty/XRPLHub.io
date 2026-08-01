// src/app/verify/[certId]/page.tsx
// Public, shareable credential verification page.
// A borrower/counterparty sends this link; anyone can open it and see whether
// the credential is authentic. No login, no wallet, no friction.

import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();
const SIGNING_SECRET = process.env.CREDENTIAL_SIGNING_SECRET || '';

export const dynamic = 'force-dynamic';

function signPayload(data: Record<string, unknown>): string {
  const canonical = JSON.stringify(data, Object.keys(data).sort());
  if (!SIGNING_SECRET) return 'UNSIGNED-DEV-' + crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
  return crypto.createHmac('sha256', SIGNING_SECRET).update(canonical).digest('hex');
}

const WRAP: React.CSSProperties = {
  minHeight: '100vh', background: '#070b14', color: '#fff',
  fontFamily: "'Inter',system-ui,sans-serif", display: 'flex',
  alignItems: 'center', justifyContent: 'center', padding: 20,
};
const CARD: React.CSSProperties = {
  maxWidth: 520, width: '100%', background: 'rgba(255,255,255,.03)',
  border: '1px solid rgba(255,255,255,.1)', borderRadius: 20, padding: 32,
};

export default async function VerifyPage({ params }: { params: Promise<{ certId: string }> }) {
  const { certId: raw } = await params;
  const certId = decodeURIComponent(raw || '').trim().toUpperCase();

  let cred = null;
  try {
    cred = await prisma.scoreCredential.findUnique({ where: { certId } });
  } catch { /* fall through to not-found state */ }

  if (!cred || cred.status !== 'ISSUED') {
    return (
      <main style={WRAP}>
        <div style={CARD}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>⚠️</div>
          <h1 style={{ fontSize: 22, fontWeight: 900, marginBottom: 8 }}>No such credential</h1>
          <p style={{ color: 'rgba(255,255,255,.5)', fontSize: 14, lineHeight: 1.7 }}>
            No issued XRPLScore credential matches <code style={{ color: '#f87171' }}>{certId || '(none)'}</code>.
            Check the certificate ID and try again.
          </p>
          <a href="https://www.xrplhub.io" style={{ display: 'inline-block', marginTop: 22, color: '#10b981', fontSize: 13, fontWeight: 700 }}>
            ← XRPLHub.io
          </a>
        </div>
      </main>
    );
  }

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

  const accent = valid ? '#10b981' : expired ? '#f59e0b' : '#f87171';
  const headline = valid ? 'Verified Credential' : expired ? 'Expired Credential' : 'Invalid Credential';
  const icon = valid ? '✅' : expired ? '⏳' : '❌';

  return (
    <main style={WRAP}>
      <div style={{ ...CARD, boxShadow: `0 0 60px ${accent}22`, borderColor: `${accent}44` }}>
        <div style={{ textAlign: 'center', marginBottom: 26 }}>
          <div style={{ fontSize: 52, marginBottom: 10 }}>{icon}</div>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: accent, marginBottom: 6 }}>
            XRPLHub.io
          </div>
          <h1 style={{ fontSize: 24, fontWeight: 900, color: accent }}>{headline}</h1>
        </div>

        <div style={{ textAlign: 'center', padding: '22px 0', borderTop: '1px solid rgba(255,255,255,.08)', borderBottom: '1px solid rgba(255,255,255,.08)', marginBottom: 22 }}>
          <div style={{ fontSize: 56, fontWeight: 900, color: accent, lineHeight: 1 }}>{cred.score}</div>
          <div style={{ fontSize: 14, color: 'rgba(255,255,255,.6)', marginTop: 6 }}>{cred.grade}</div>
          {cred.percentile != null && (
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,.38)', marginTop: 4 }}>
              Top {100 - cred.percentile}% of scanned XRPL wallets
            </div>
          )}
        </div>

        <Row label="Wallet" value={cred.walletAddress} mono />
        <Row label="Certificate ID" value={cred.certId} mono />
        <Row label="Issued" value={cred.issuedAt.toISOString().slice(0, 10)} />
        <Row label="Valid until" value={cred.expiresAt.toISOString().slice(0, 10)} />
        <Row label="Signature" value={signatureValid ? 'Cryptographically valid' : 'MISMATCH — do not trust'} />
        {cred.txHash && (
          <div style={{ marginTop: 16 }}>
            <a href={`https://xrpscan.com/tx/${cred.txHash}`} target="_blank" rel="noopener noreferrer"
               style={{ fontSize: 12, color: '#10b981', fontWeight: 600 }}>
              View issuance payment on XRPScan ↗
            </a>
          </div>
        )}

        {!SIGNING_SECRET && (
          <p style={{ marginTop: 18, fontSize: 11, color: '#f59e0b', lineHeight: 1.6 }}>
            Note: the issuer signing key is not configured, so this credential is not cryptographically binding.
          </p>
        )}

        <p style={{ marginTop: 22, fontSize: 11, color: 'rgba(255,255,255,.3)', lineHeight: 1.7, textAlign: 'center' }}>
          Scores are computed from public XRP Ledger data. A credential attests to the score at its issuance date —
          it is not financial advice and not a guarantee of future conduct.
        </p>
      </div>
    </main>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '7px 0', fontSize: 12 }}>
      <span style={{ color: 'rgba(255,255,255,.4)', flexShrink: 0 }}>{label}</span>
      <span style={{ color: 'rgba(255,255,255,.8)', textAlign: 'right', wordBreak: 'break-all', fontFamily: mono ? "'IBM Plex Mono',monospace" : 'inherit' }}>
        {value}
      </span>
    </div>
  );
}

// src/app/api/execute/verify/route.ts
// Polled by the frontend after the execution QR is shown (Xaman: ?uuid=) or after an injected
// wallet broadcasts the service transaction (?hash=&payTxHash=).
// Returns: pending | step_delivered | delivered | expired | rejected | failed
//   step_delivered  one step of a multi-step service is confirmed; `nextStep` says what to sign next
//   delivered       the LAST step is confirmed — the payment is now fully used
//
// DELIVERY IS RECORDED ONLY AGAINST THE DATABASE ROW (paymentGate.recordStepDelivered): the
// product, plan and payer come from the row created when the payment was verified — never from
// query-string parameters — and the confirmed transaction must be validated, tesSUCCESS, signed by
// the payer, of the type the plan expects for this step, and not older than the payment. So a
// payment hash can't be marked delivered (or "burned") by someone else's unrelated transaction.
// Requires env vars: XUMM_API_KEY, XUMM_API_SECRET

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/xrplscore-db';
import { registerNewMptIssuance } from '@/lib/mptRegister';
import { fetchLedgerTx, recordStepDelivered, type DeliveryResult } from '@/lib/paymentGate';
import { prismaPurchaseStore } from '@/lib/paymentStore';

const XUMM_STATUS = 'https://xumm.app/api/v1/platform/payload';
const HASH_RE = /^[0-9A-Fa-f]{64}$/;

/** Confirm `serviceTxHash` on the ledger and record it against `payTxHash`. */
async function confirmDelivery(serviceTxHash: string, payTxHash: string) {
  const svc = await fetchLedgerTx(serviceTxHash);
  if (!svc.ok) return NextResponse.json({ status: 'pending', txHash: serviceTxHash });
  const meta = (svc.tx.meta ?? svc.tx.metaData) as Record<string, unknown> | undefined;
  const result = meta?.TransactionResult as string | undefined;
  if (svc.tx.validated !== true || !result) return NextResponse.json({ status: 'pending', txHash: serviceTxHash });
  if (result !== 'tesSUCCESS') return NextResponse.json({ status: 'failed', txHash: serviceTxHash, result });

  const pay = await fetchLedgerTx(payTxHash);
  const paymentLedgerIndex = pay.ok && typeof pay.tx.ledger_index === 'number' ? pay.tx.ledger_index : null;

  const rec: DeliveryResult = await recordStepDelivered(prismaPurchaseStore(), {
    payTxHash: payTxHash.toUpperCase(), serviceTxHash: serviceTxHash.toUpperCase(), serviceTx: svc.tx, paymentLedgerIndex,
  });
  if (!rec.ok) {
    if (rec.retry) return NextResponse.json({ status: 'pending', txHash: serviceTxHash });
    return NextResponse.json({ status: 'failed', txHash: serviceTxHash, result: rec.code, reason: rec.reason });
  }

  const base = { txHash: serviceTxHash, step: rec.step, totalSteps: rec.totalSteps };
  if (!rec.done) {
    return NextResponse.json({ status: 'step_delivered', ...base, nextStep: rec.nextStep ? { step: rec.nextStep.step, id: rec.nextStep.id } : null });
  }
  let mpt: Awaited<ReturnType<typeof registerNewMptIssuance>> | undefined;
  if (rec.productId === 'mptissue') {
    mpt = await registerNewMptIssuance(prisma, String(svc.tx.Account ?? ''), svc.tx).catch(() => undefined);
  }
  return NextResponse.json({ status: 'delivered', ...base, mptIssuanceId: mpt?.issuanceId ?? null, registry: mpt });
}

export async function GET(req: NextRequest) {
  try {
    const uuid = req.nextUrl.searchParams.get('uuid');
    const hashParam = req.nextUrl.searchParams.get('hash');   // injected-wallet path
    const payTxHashParam = req.nextUrl.searchParams.get('payTxHash') ?? '';

    // ---- injected wallet: confirm the service tx it broadcast, on-ledger ----
    if (hashParam) {
      if (!HASH_RE.test(hashParam)) return NextResponse.json({ status: 'error', reason: 'bad hash' }, { status: 400 });
      if (!HASH_RE.test(payTxHashParam)) return NextResponse.json({ status: 'error', reason: 'payTxHash required' }, { status: 400 });
      return confirmDelivery(hashParam, payTxHashParam);
    }

    if (!uuid) return NextResponse.json({ error: 'uuid required' }, { status: 400 });

    const apiKey = process.env.XUMM_API_KEY;
    const apiSecret = process.env.XUMM_API_SECRET;
    if (!apiKey || !apiSecret) return NextResponse.json({ error: 'gateway not configured' }, { status: 503 });

    const res = await fetch(`${XUMM_STATUS}/${encodeURIComponent(uuid)}`, {
      headers: { 'X-API-Key': apiKey, 'X-API-Secret': apiSecret },
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json();

    const meta = data?.meta;
    if (!meta) return NextResponse.json({ status: 'pending' });
    if (meta.expired) return NextResponse.json({ status: 'expired' });
    if (meta.resolved && !meta.signed) return NextResponse.json({ status: 'rejected' });
    if (!meta.signed) return NextResponse.json({ status: 'pending' });

    // Signed — the payload is ONE WE created, so its blob names the payment it belongs to.
    const txHash = data?.response?.txid;
    if (!txHash) return NextResponse.json({ status: 'pending' });
    let blob: { payTxHash?: string } = {};
    try { blob = data?.custom_meta?.blob ? JSON.parse(data.custom_meta.blob) : {}; } catch { /* leave empty */ }
    if (!blob.payTxHash || !HASH_RE.test(blob.payTxHash)) return NextResponse.json({ status: 'failed', txHash, result: 'no_payment_record' });
    return confirmDelivery(txHash, blob.payTxHash);
  } catch (err) {
    console.error('[execute/verify]', err);
    return NextResponse.json({ status: 'pending' });
  }
}

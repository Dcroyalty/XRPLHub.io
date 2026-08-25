// src/app/api/execute/verify/route.ts
// Polled by the frontend after the execution QR is shown.
// Returns: pending | delivered | expired | rejected | failed
// "delivered" REQUIRES the service transaction to have reached tesSUCCESS on mainnet.
// Requires env vars: XUMM_API_KEY, XUMM_API_SECRET

import { NextRequest, NextResponse } from 'next/server';
import { recordPurchase } from '@/lib/recordPurchase';

const XUMM_STATUS = 'https://xumm.app/api/v1/platform/payload';
const XRPL_API    = 'https://xrplcluster.com/';
const XRPL_BACKUP = 'https://s1.ripple.com:51234/';

async function txResult(txHash: string): Promise<string | null> {
  for (const url of [XRPL_API, XRPL_BACKUP]) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'tx', params: [{ transaction: txHash, binary: false }] }),
        signal: AbortSignal.timeout(8_000),
      });
      const d = await res.json();
      const meta = d?.result?.meta as Record<string, unknown> | undefined;
      if (meta?.TransactionResult) return meta.TransactionResult as string;
    } catch { continue; }
  }
  return null;
}

export async function GET(req: NextRequest) {
  try {
    const uuid = req.nextUrl.searchParams.get('uuid');
    if (!uuid) return NextResponse.json({ error: 'uuid required' }, { status: 400 });

    const apiKey = process.env.XUMM_API_KEY;
    const apiSecret = process.env.XUMM_API_SECRET;
    if (!apiKey || !apiSecret) return NextResponse.json({ error: 'gateway not configured' }, { status: 503 });

    const res = await fetch(`${XUMM_STATUS}/${uuid}`, {
      headers: { 'X-API-Key': apiKey, 'X-API-Secret': apiSecret },
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json();

    const meta = data?.meta;
    if (!meta) return NextResponse.json({ status: 'pending' });
    if (meta.expired) return NextResponse.json({ status: 'expired' });
    if (meta.resolved && !meta.signed) return NextResponse.json({ status: 'rejected' });
    if (!meta.signed) return NextResponse.json({ status: 'pending' });

    // Signed â€” now confirm on-chain success.
    const txHash = data?.response?.txid;
    if (!txHash) return NextResponse.json({ status: 'pending' });

    const result = await txResult(txHash);
    if (!result) return NextResponse.json({ status: 'pending', txHash });
    if (result !== 'tesSUCCESS') return NextResponse.json({ status: 'failed', txHash, result });

    // Mark the purchase DELIVERED â€” directly in the DB (no internal HTTP hop).
    // blob = { productId, account, payTxHash }; payTxHash is the PAYMENT tx, the
    // key the check-payment row was written under, so map it to txHash.
    try {
      const blob = data?.custom_meta?.blob ? JSON.parse(data.custom_meta.blob) : {};
      await recordPurchase({
        productId: blob.productId,
        sender: blob.account ?? null,
        txHash: blob.payTxHash ?? null,
        serviceTxHash: txHash,
        status: 'DELIVERED',
        deliveredAt: new Date().toISOString(),
      });
    } catch {}

    return NextResponse.json({ status: 'delivered', txHash });
  } catch (err) {
    console.error('[execute/verify]', err);
    return NextResponse.json({ status: 'pending' });
  }
}

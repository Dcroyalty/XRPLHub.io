// src/app/api/execute/route.ts
// AUTONOMOUS EXECUTION ENGINE — step 2 of every purchase.
// After the customer's PAYMENT to treasury is verified, this builds the actual
// service transaction (on the CUSTOMER'S own wallet) and returns a Xaman
// sign request. The customer signs once; /api/execute/verify confirms on-chain.
//
// Anti-fraud: we require a verified payment txHash before we will build anything.
// Requires env vars: XUMM_API_KEY, XUMM_API_SECRET

import { NextRequest, NextResponse } from 'next/server';
import { buildServiceTx } from './txBuilder';

const XUMM_API  = 'https://xumm.app/api/v1/platform/payload';
const XRPL_API  = 'https://xrplcluster.com/';
const TREASURY  = 'rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF';

// Confirm the payment that entitles this execution actually happened (tesSUCCESS, to treasury).
async function paymentIsValid(payTxHash: string): Promise<boolean> {
  try {
    const res = await fetch(XRPL_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'tx', params: [{ transaction: payTxHash, binary: false }] }),
      signal: AbortSignal.timeout(8_000),
    });
    const d = await res.json();
    const tx = d?.result;
    if (!tx?.Account) return false;
    const meta = tx.meta as Record<string, unknown>;
    return meta?.TransactionResult === 'tesSUCCESS' && tx.Destination === TREASURY && tx.TransactionType === 'Payment';
  } catch { return false; }
}

export async function POST(req: NextRequest) {
  try {
    const { productId, account, params, payTxHash, confirmedCaution } = await req.json();

    const apiKey = process.env.XUMM_API_KEY;
    const apiSecret = process.env.XUMM_API_SECRET;
    if (!productId || !account) {
      return NextResponse.json({ error: 'productId and account are required' }, { status: 400 });
    }
    // Anti-fraud gate: must have paid first.
    if (!payTxHash || !(await paymentIsValid(payTxHash))) {
      return NextResponse.json({ error: 'No verified payment found for this order. Pay first, then execute.' }, { status: 402 });
    }

    // Build the exact service transaction for the customer's own wallet.
    const built = buildServiceTx(productId, account, params || {});
    if (!built.ok) {
      if (built.tier === 'blocked') return NextResponse.json({ error: built.error, tier: 'blocked' }, { status: 403 });
      if (built.needsParams?.length) return NextResponse.json({ error: built.error, needsParams: built.needsParams }, { status: 422 });
      return NextResponse.json({ error: built.error }, { status: 400 });
    }
    // Caution tier requires explicit customer acknowledgement of irreversibility risk.
    if (built.tier === 'caution' && !confirmedCaution) {
      return NextResponse.json({
        tier: 'caution',
        requiresConfirmation: true,
        warning: 'This operation changes how your wallet is controlled and may be difficult or impossible to reverse. You must confirm you understand before signing.',
        label: built.label,
      }, { status: 409 });
    }

    // Xaman sign request — only when Xaman is configured. An injected wallet
    // (Crossmark / GemWallet) submits `txjson` itself and polls verify?hash=.
    let xaman: { uuid: string; qr_png: string | null; deep_link: string | null } | null = null;
    if (apiKey && apiSecret) {
      const payload = {
        txjson: built.txjson,
        options: { submit: true, expire: 15 },
        custom_meta: {
          identifier: `xrplhub_exec_${productId}_${Date.now()}`,
          blob: JSON.stringify({ productId, account, payTxHash }),
          instruction: `XRPLHub — ${built.label}\nSign to execute your service on XRPL mainnet.`,
        },
      };
      const res = await fetch(XUMM_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey, 'X-API-Secret': apiSecret },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      const data = await res.json();
      if (res.ok && data?.uuid) {
        xaman = { uuid: data.uuid, qr_png: data.refs?.qr_png ?? null, deep_link: data.next?.always ?? null };
      } else {
        console.error('[execute] Xaman error:', JSON.stringify(data));
      }
    }

    return NextResponse.json({
      uuid: xaman?.uuid ?? null,
      qr_png: xaman?.qr_png ?? null,
      deep_link: xaman?.deep_link ?? null,
      txjson: built.txjson,           // injected-wallet path submits this
      label: built.label,
      tier: built.tier,
      expires_in: 900,
    });
  } catch (err) {
    console.error('[execute]', err);
    return NextResponse.json({ error: 'Execution failed. Please try again or contact support@xrplhub.io' }, { status: 500 });
  }
}

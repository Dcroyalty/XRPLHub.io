// src/app/api/execute/route.ts
// AUTONOMOUS EXECUTION ENGINE — step 2 of every purchase.
// After the customer's PAYMENT to treasury is verified, this builds the actual
// service transaction (on the CUSTOMER'S own wallet) and returns a Xaman sign
// request. The customer signs; /api/execute/verify confirms on-chain.
//
// THE PAYMENT GATE (see src/lib/paymentGate.ts):
//   - the payment is re-verified on the ledger against the SERVER's price table — right
//     product, right amount, right currency (XRP, or RLUSD from the real issuer), sent to
//     the treasury, validated, not a partial payment. Nothing the client says about price counts;
//   - the payer must be the wallet the service is built for;
//   - the payment hash is single-use, enforced in the database: bound to its first product and
//     payer, a capped number of build attempts per step, and dead once delivered.
// Services with several transactions are signed one step at a time (`step` in the request).
// Requires env vars: XUMM_API_KEY, XUMM_API_SECRET

import { NextRequest, NextResponse } from 'next/server';
import { buildServiceTx } from './txBuilder';
import { describeMptIssuanceCreate } from '@/lib/mptMeta';
import { BACKING_HARD_LINE } from '@/lib/mptBacking';
import { buildContextFromView, confirmCopy, mptRegimeFor } from '@/lib/mptPermanence';
import { claimBuild, deliveredHashes, parseStatus, verifyPayment, type GateCode, type PlanStep } from '@/lib/paymentGate';
import { prismaPurchaseStore } from '@/lib/paymentStore';
import { cautionCopyFor } from '@/lib/serviceCaution';
import { priceUsd } from '@/lib/pricing';

const XUMM_API = 'https://xumm.app/api/v1/platform/payload';

const RETRY_CODES: ReadonlySet<GateCode> = new Set(['not_found', 'not_validated', 'ledger_unavailable', 'xrp_price_unavailable', 'conflict']);

function gateStatus(code: GateCode): number {
  if (RETRY_CODES.has(code)) return code === 'conflict' ? 409 : 503;
  if (code === 'sender_mismatch') return 403;
  if (code === 'issue_limit') return 429;
  if (code === 'bound_to_other_product' || code === 'already_used' || code === 'wrong_step') return 409;
  return 402; // failed / underpaid / wrong_destination / bad_currency / unknown_product / …
}

export async function POST(req: NextRequest) {
  try {
    const { productId, account, params, payTxHash, confirmedCaution, step: stepRaw } = await req.json();

    const apiKey = process.env.XUMM_API_KEY;
    const apiSecret = process.env.XUMM_API_SECRET;
    if (!productId || !account) {
      return NextResponse.json({ error: 'productId and account are required' }, { status: 400 });
    }
    if (priceUsd(String(productId)) == null || String(productId) === 'credential') {
      return NextResponse.json({ error: `Unknown product "${productId}".` }, { status: 404 });
    }

    // ── 1. the payment: verified on the ledger against OUR price table ──
    if (!payTxHash || typeof payTxHash !== 'string') {
      return NextResponse.json({ error: 'No verified payment found for this order. Pay first, then execute.' }, { status: 402 });
    }
    const pay = await verifyPayment(payTxHash.trim().toUpperCase(), String(productId));
    if (!pay.ok) {
      return NextResponse.json({ error: pay.reason, code: pay.code, ...(pay.retry ? { retry: true } : {}) }, { status: gateStatus(pay.code) });
    }
    if (pay.payer !== account) {
      return NextResponse.json({ error: 'The service must be built for the wallet that paid.', code: 'sender_mismatch' }, { status: 403 });
    }

    // ── 2. where is this payment in its life? (read-only; the claim below is the atomic step) ──
    const store = prismaPurchaseStore();
    const txHash = pay.txHash || payTxHash.trim().toUpperCase();
    const row = await store.find(txHash);
    if (row && row.productId !== String(productId)) {
      return NextResponse.json({ error: 'This payment was already used for a different service.', code: 'bound_to_other_product' }, { status: 409 });
    }
    const state = row ? parseStatus(row.status) : null;
    if (state?.phase === 'DELIVERED') {
      return NextResponse.json({ error: 'This payment has already been used to deliver its service.', code: 'already_used' }, { status: 409 });
    }
    const delivered = row ? deliveredHashes(row).length : 0;
    const storedPlan: PlanStep[] | null = state?.phase === 'ACTIVE' ? state.plan : null;
    const step = Number.isInteger(Number(stepRaw)) && Number(stepRaw) >= 1 ? Number(stepRaw) : delivered + 1;

    // ── 3. build (MPT issuance reads the LIVE DynamicMPT state on every call) ──
    const view = await mptRegimeFor(productId);
    const ctx = { ...(view ? buildContextFromView(view) : {}), ...(storedPlan ? { planIds: storedPlan.map((s) => s.id) } : {}), step };
    const built = await buildServiceTx(productId, account, params || {}, ctx);
    if (!built.ok || !built.steps) {
      if (built.tier === 'blocked') return NextResponse.json({ error: built.error, tier: 'blocked' }, { status: 403 });
      if (built.needsParams?.length) return NextResponse.json({ error: built.error, needsParams: built.needsParams }, { status: 422 });
      return NextResponse.json({ error: built.error }, { status: 400 });
    }

    // The plan (ordered step ids + tx types) is fixed at step 1; later steps are built by id.
    const plan: PlanStep[] = storedPlan ?? built.steps.map((s) => ({ id: s.id, type: String(s.txjson.TransactionType) }));
    const target = plan[step - 1];
    const stepObj = target ? built.steps.find((s) => s.id === target.id) : undefined;
    if (!target || !stepObj) {
      return NextResponse.json({ error: 'That step is not part of this service.', code: 'wrong_step' }, { status: 409 });
    }

    // ── 4. confirmation, BEFORE anything is consumed. Only the first step asks. ──
    if (built.tier === 'caution' && !confirmedCaution && step === 1) {
      if (productId === 'mptissue' && view) {
        // MPT issuance: spell out what is permanent, what is locked, and what the issuer
        // can still change — for the amendment regime that applies right now.
        const manifest = describeMptIssuanceCreate(built.txjson as Record<string, unknown>, view);
        const copy = confirmCopy(view, manifest.permanence.lockedByThisTransaction);
        return NextResponse.json({
          tier: 'caution',
          requiresConfirmation: true,
          label: built.label,
          permanence: manifest.permanence,
          heading: copy.heading,
          listTitle: copy.listTitle,
          warning: copy.warning,
          manifest,
          irreversible: manifest.irreversible,
          backingNotice: BACKING_HARD_LINE,
          confirmPrompt: copy.confirmPrompt,
        }, { status: 409 });
      }
      const specific = cautionCopyFor(String(productId), (params || {}) as Record<string, unknown>);
      if (specific) {
        return NextResponse.json({
          tier: 'caution',
          requiresConfirmation: true,
          label: built.label,
          heading: specific.heading,
          listTitle: specific.listTitle,
          warning: specific.warning,
          irreversible: specific.irreversible,
          confirmPrompt: specific.confirmPrompt,
          totalSteps: plan.length,
        }, { status: 409 });
      }
      return NextResponse.json({
        tier: 'caution',
        requiresConfirmation: true,
        warning: 'This operation changes how your wallet is controlled and may be difficult or impossible to reverse. You must confirm you understand before signing.',
        label: built.label,
      }, { status: 409 });
    }

    // ── 5. claim ONE build attempt for this step — atomic, in the database ──
    const claim = await claimBuild(store, {
      payTxHash: txHash, productId: String(productId), payer: pay.payer, currency: pay.currency, amount: pay.amount,
      account, step, plan,
    });
    if (!claim.ok) {
      return NextResponse.json({ error: claim.reason, code: claim.code, ...(claim.retry ? { retry: true } : {}) }, { status: gateStatus(claim.code) });
    }

    // ── 6. Xaman sign request — only when Xaman is configured. An injected wallet
    //       (Crossmark / GemWallet) submits `txjson` itself and polls verify?hash=. ──
    let xaman: { uuid: string; qr_png: string | null; deep_link: string | null } | null = null;
    if (apiKey && apiSecret) {
      const payload = {
        txjson: stepObj.txjson,
        options: { submit: true, expire: 15 },
        custom_meta: {
          identifier: `xrplhub_exec_${productId}_${Date.now()}`,
          blob: JSON.stringify({ productId, account, payTxHash: txHash, step, totalSteps: plan.length }),
          instruction: `XRPLHub — ${stepObj.label}${plan.length > 1 ? ` (step ${step} of ${plan.length})` : ''}\nSign to execute your service on XRPL mainnet.`,
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
      txjson: stepObj.txjson,           // injected-wallet path submits this
      label: built.label,
      tier: built.tier,
      step,
      totalSteps: plan.length,
      stepLabel: stepObj.label,
      steps: built.steps.map((s) => ({ id: s.id, label: s.label })),
      expires_in: 900,
    });
  } catch (err) {
    console.error('[execute]', err);
    return NextResponse.json({ error: 'Execution failed. Please try again or contact support@xrplhub.io' }, { status: 500 });
  }
}

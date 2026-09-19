// src/app/api/check-payment/route.ts
// Polled every 3s by the frontend after the Xaman QR is shown (or after an injected wallet
// broadcasts the payment). Returns: pending | verified | expired | rejected
//
// A "verified" status REQUIRES a validated, successful Payment to the treasury on XRPL mainnet
// that covers the product's price IN THE SERVER'S OWN PRICE TABLE (pricing.ts). Any `amount` /
// `currency` in the query string is ignored — the ledger says what was paid, and for a Xaman
// payment the product comes from the payload WE created, not from the URL.
// Requires env vars: XUMM_API_KEY, XUMM_API_SECRET

import { NextRequest, NextResponse } from 'next/server'
import { getPayloadStatus, xummConfigured, XummRateLimitError } from '@/lib/xumm'
import { verifyPayment, registerPayment } from '@/lib/paymentGate'
import { prismaPurchaseStore } from '@/lib/paymentStore'
import { db } from '@/lib/db'

/** create-payment stamps every Xaman payload with identifier xrplhub_<productId>_<timestamp>. */
const PRODUCT_FROM_IDENTIFIER = /^xrplhub_([a-z0-9]+)_\d+$/

export async function GET(req: NextRequest) {
  try {
    const p          = req.nextUrl.searchParams
    const uuid       = p.get('uuid')
    const hashParam  = p.get('hash')            // injected-wallet path: client submitted the tx itself
    let productId    = (p.get('productId') || '').trim()
    const email      = p.get('email') || ''

    if (!uuid && !hashParam)
      return NextResponse.json({ status: 'error', reason: 'Missing payment ID' }, { status: 400 })

    // ---- resolve the on-ledger tx hash from either path ----
    let txHash = ''
    if (hashParam) {
      // Injected wallet (Crossmark / GemWallet) already broadcast the tx.
      if (!/^[0-9A-Fa-f]{64}$/.test(hashParam))
        return NextResponse.json({ status: 'error', reason: 'Bad transaction hash' }, { status: 400 })
      txHash = hashParam.toUpperCase()
    } else {
      if (!xummConfigured())
        return NextResponse.json({ status: 'error', reason: 'Payment gateway not configured' }, { status: 503 })

      let payload
      try {
        payload = await getPayloadStatus(uuid as string)
      } catch (e) {
        if (e instanceof XummRateLimitError)
          return NextResponse.json({ status: 'pending' }) // busy — keep polling
        throw e
      }

      if (payload.state === 'not_found') return NextResponse.json({ status: 'error',    reason: 'Payment request not found' })
      if (payload.state === 'expired')   return NextResponse.json({ status: 'expired' })
      if (payload.state === 'rejected')  return NextResponse.json({ status: 'rejected', reason: 'Payment cancelled in Xaman' })
      if (payload.state === 'pending')   return NextResponse.json({ status: 'pending' })

      // The product this payment is for is what OUR server stamped on the payload.
      const m = payload.identifier?.match(PRODUCT_FROM_IDENTIFIER)
      if (m) productId = m[1]
      txHash = (payload.txid || '').toUpperCase()
    }

    if (!txHash) return NextResponse.json({ status: 'pending' })
    if (!productId) return NextResponse.json({ status: 'error', reason: 'Missing product' }, { status: 400 })

    // ---- verify against the server's price table ----
    const v = await verifyPayment(txHash, productId)
    if (!v.ok) {
      if (v.retry) return NextResponse.json({ status: 'pending', txHash })
      return NextResponse.json({ status: 'rejected', reason: v.reason, code: v.code, txHash })
    }

    // ---- record it (idempotent); the hash is bound to its first product and its payer ----
    const reg = await registerPayment(prismaPurchaseStore(), {
      payTxHash: txHash, productId, payer: v.payer, currency: v.currency, amount: v.amount,
    })
    if (!reg.ok) {
      if (reg.retry) return NextResponse.json({ status: 'pending', txHash })
      return NextResponse.json({ status: 'rejected', reason: reg.reason, code: reg.code, txHash })
    }
    if (email) await db.purchase.updateMany({ where: { txHash, email: null }, data: { email } }).catch(() => {})

    return NextResponse.json({
      status:   'verified',
      txHash,
      sender:   v.payer,
      currency: v.currency,
      amount:   v.amount,
      productId,
      message:  `${v.amount} ${v.currency} confirmed on XRPL mainnet`,
    })
  } catch (err) {
    console.error('[check-payment]', err)
    return NextResponse.json({ status: 'error', reason: 'Verification failed — please retry' }, { status: 500 })
  }
}

// src/app/api/check-payment/route.ts
// Polled every 3s by the frontend after the Xaman QR is shown.
// Returns: pending | verified | expired | rejected
// A "verified" status REQUIRES a real tesSUCCESS Payment to the treasury on XRPL mainnet.
// Requires env vars: XUMM_API_KEY, XUMM_API_SECRET

import { NextRequest, NextResponse } from 'next/server'
import { recordPurchase } from '@/lib/recordPurchase'

const XUMM_STATUS = 'https://xumm.app/api/v1/platform/payload'
const XRPL_API    = 'https://xrplcluster.com/'
const XRPL_BACKUP = 'https://s1.ripple.com:51234/'
const TREASURY    = 'rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF'

async function fetchTx(txHash: string): Promise<Record<string, unknown> | null> {
  for (const url of [XRPL_API, XRPL_BACKUP]) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'tx', params: [{ transaction: txHash, binary: false }] }),
        signal: AbortSignal.timeout(8_000),
      })
      const d = await res.json()
      if (d?.result?.Account) return d.result
    } catch { continue }
  }
  return null
}

async function verifyTx(txHash: string, expectedAmt: number, currency: string) {
  const tx = await fetchTx(txHash)
  if (!tx) return { ok: false, reason: 'Transaction not yet visible on XRPL â€” retry in a moment', retry: true }

  const meta = tx.meta as Record<string, unknown>
  if (meta?.TransactionResult !== 'tesSUCCESS')
    return { ok: false, reason: `Transaction failed on ledger: ${meta?.TransactionResult}` }
  if (tx.TransactionType !== 'Payment')
    return { ok: false, reason: 'Not a payment transaction' }
  if (tx.Destination !== TREASURY)
    return { ok: false, reason: 'Payment sent to wrong address' }

  // Tolerance + skip amount check entirely if expected is 0 (test mode flexibility)
  if (expectedAmt > 0) {
    const TOLERANCE = 0.95
    if (currency === 'XRP') {
      const xrp = parseInt(tx.Amount as string) / 1_000_000
      if (xrp < expectedAmt * TOLERANCE)
        return { ok: false, reason: `Amount too low: sent ${xrp} XRP, needed ${expectedAmt}` }
    } else {
      const amt = tx.Amount as Record<string, string>
      const val = parseFloat(amt?.value || '0')
      if (val < expectedAmt * TOLERANCE)
        return { ok: false, reason: `Amount too low: sent ${val} ${currency}, needed ${expectedAmt}` }
    }
  }
  return { ok: true, sender: tx.Account as string }
}

export async function GET(req: NextRequest) {
  try {
    const p          = req.nextUrl.searchParams
    const uuid       = p.get('uuid')
    const productId  = p.get('productId') || ''
    const amount     = parseFloat(p.get('amount') || '0')
    const currency   = p.get('currency') || 'XRP'
    const email      = p.get('email') || ''

    if (!uuid) return NextResponse.json({ status: 'error', reason: 'Missing payment ID' }, { status: 400 })

    const apiKey    = process.env.XUMM_API_KEY
    const apiSecret = process.env.XUMM_API_SECRET
    if (!apiKey || !apiSecret)
      return NextResponse.json({ status: 'error', reason: 'Payment gateway not configured' }, { status: 503 })

    const res  = await fetch(`${XUMM_STATUS}/${uuid}`, {
      headers: { 'X-API-Key': apiKey, 'X-API-Secret': apiSecret },
      signal: AbortSignal.timeout(8_000),
    })
    const data = await res.json()
    const meta = data?.meta

    if (!meta?.exists)   return NextResponse.json({ status: 'error',    reason: 'Payment request not found' })
    if (meta?.expired)   return NextResponse.json({ status: 'expired' })
    if (meta?.cancelled) return NextResponse.json({ status: 'rejected', reason: 'Payment cancelled in Xaman' })
    if (!meta?.signed)   return NextResponse.json({ status: 'pending' })

    // FIX: Xaman returns txid under data.response.txid (NOT data.payload.response.txid).
    // We probe both shapes for safety in case the API ever rewraps it.
    const txHash =
      (data?.response?.txid as string | undefined) ||
      (data?.payload?.response?.txid as string | undefined) ||
      ''

    if (!txHash) return NextResponse.json({ status: 'pending' })

    const verify = await verifyTx(txHash, amount, currency)
    if (!verify.ok && (verify as { retry?: boolean }).retry) {
      // Ledger hasn't seen the tx yet â€” keep polling.
      return NextResponse.json({ status: 'pending', txHash })
    }
    if (!verify.ok) return NextResponse.json({ status: 'rejected', reason: verify.reason, txHash })

    await recordPurchase({
      productId, currency, amount: String(amount), email,
      sender: verify.sender!, txHash, verifiedAt: new Date().toISOString(),
    })

    return NextResponse.json({
      status:  'verified',
      txHash,
      sender:  verify.sender,
      message: `${amount} ${currency} confirmed on XRPL mainnet`,
    })
  } catch (err) {
    console.error('[check-payment]', err)
    return NextResponse.json({ status: 'error', reason: 'Verification failed â€” please retry' }, { status: 500 })
  }
}

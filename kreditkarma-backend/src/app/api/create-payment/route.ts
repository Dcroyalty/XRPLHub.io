// src/app/api/create-payment/route.ts
// Creates a real Xaman payment request (payload) to the XRPLHub treasury.
// Requires env vars: XUMM_API_KEY, XUMM_API_SECRET
//
// THE SERVER DECIDES THE PRICE. The client sends a productId and a currency; any
// `amount` it also sends is ignored for services (pricing.ts is the only source of truth).
// Donations are the one open-amount product: the amount is the donor's choice, validated here.

import { NextRequest, NextResponse } from 'next/server'
import { createPayload, safeIdentifier, xummConfigured, XummRateLimitError } from '@/lib/xumm'
import { rateLimit, rateLimited } from '@/lib/rateLimit'
import {
  OPEN_AMOUNT_PRODUCTS, PricingError, RLUSD_HEX, RLUSD_ISSUER, TREASURY, quote, type PayCurrency,
} from '@/lib/pricing'
import { prisma } from '@/lib/xrplscore-db'
import { allocateDestinationTag } from '@/lib/purchaseIntent'
import { SERVICE_REQUIRED_AMENDMENT, serviceAvailability } from '@/lib/serviceAmendments'

const NAMES: Record<string, string> = {
  multisig:'Multi-Sig Fortress', regkey:'Regular Key Rotator', depositauth:'Deposit Auth Guard',
  desttag:'Destination Tag Lock', issuerdecl:'Issuer Trustless Declaration',
  tokenfee:'Token Transfer Fee', issuercfg:'Full Issuer Config', trustline:'Trust Line Configurator',
  rippling:'Rippling Controller', dexorder:'DEX Order Builder', ammlaunch:'AMM Pool Launch',
  ammentry:'AMM Liquidity Entry', smartswap:'Smart Swap Router', paychannel:'Payment Channel',
  nftmint:'NFT Minter', nftburn:'NFT Burn Certificate', nftoffer:'NFT Offer Creator',
  identity:'On-Chain Identity', did:'DID Creator', compliance:'Compliance Bundle',
  escrow:'Escrow Setup',
  mptissue:'Multi-Purpose Token Issuance', mptsend:'Send MPT', trustsend:'Trust Line + Send Currency',
  globalfreeze:'Global Freeze', freezeline:'Freeze a Trust Line',
  checkcreate:'Create a Check', checkcash:'Cash a Check', checkcancel:'Cancel a Check',
  depositpreauth:'Deposit Preauthorization', ammwithdraw:'AMM Liquidity Exit', tickets:'Ticket Batch Setup',
  credentialissue:'Issue a Credential', permdomain:'Permissioned Domain', delegate:'Permission Delegation',
  credential:'XRPLScore Verified Credential (90 days)',
  donate:'Community Grant treasury donation',
}

const MAX_DONATION = 1_000_000

const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex').toUpperCase()

export async function POST(req: NextRequest) {
  // Each call can create a Xaman payload (a third-party API with its own quota): cap it per client.
  const rl = rateLimit(req, 'create-payment', 12, 60_000)
  if (!rl.ok) return rateLimited(rl)
  try {
    const { productId, currency, amount, email } = await req.json()
    const product = String(productId ?? '').trim()
    const cur = String(currency ?? 'RLUSD').toUpperCase()

    if (!/^[a-z0-9]{2,32}$/.test(product)) {
      return NextResponse.json({ error: 'Invalid product.' }, { status: 400 })
    }

    // A service that needs an amendment can't be paid for until the ledger says it's active (fail closed).
    if (SERVICE_REQUIRED_AMENDMENT[product]) {
      const avail = await serviceAvailability(product)
      if (!avail.available) {
        return NextResponse.json({ error: `${avail.message} No payment was created.`, code: 'not_available', earliestActivation: avail.earliestActivation }, { status: 409 })
      }
    }

    // ── the amount to charge — from OUR table, never from the request ──
    let payCurrency: PayCurrency
    let payAmount: string
    let priceUsd: number | null = null
    let xrpUsdRate: number | null = null
    if (OPEN_AMOUNT_PRODUCTS.has(product)) {
      if (cur !== 'XRP' && cur !== 'RLUSD') return NextResponse.json({ error: 'currency must be XRP or RLUSD' }, { status: 400 })
      const n = Number(amount)
      if (!Number.isFinite(n) || n <= 0 || n > MAX_DONATION) {
        return NextResponse.json({ error: 'Invalid amount' }, { status: 400 })
      }
      payCurrency = cur
      payAmount = String(n)
    } else {
      const q = await quote(product, cur)
      payCurrency = q.currency
      payAmount = q.amount
      priceUsd = q.priceUsd
      xrpUsdRate = q.xrpUsd
    }

    // A destination tag lets a manual payment (exchange withdrawal, any wallet, no Xaman, no injected
    // wallet, no hash ever pasted anywhere) still be found: /api/check-payment can poll by intentId and
    // a bounded ledger walk (src/lib/purchaseIntent.ts) discovers the tx, then hands it to the SAME
    // verifyPayment/registerPayment the paste-a-hash path already uses -- nothing about the gate itself
    // changes. Allocated even for Xaman/injected payers too so every path is consistent.
    // BEST-EFFORT: never let this block a real payment from being created. If it fails for any reason
    // (including the PurchaseIntent table not existing yet on a given deploy), the flow degrades to
    // exactly today's behavior -- Xaman/injected/paste-a-hash still work, only the extra auto-detection
    // is missing for that one request.
    const intent = await allocateDestinationTag(prisma, product).catch((e) => {
      console.error('[create-payment] destination-tag allocation failed (non-fatal):', e);
      return null;
    })

    // Canonical fee Payment to the treasury. Same object for Xaman and for an injected
    // wallet that submits it itself. The memo records which product it is for (audit trail).
    const txjson: Record<string, unknown> = {
      TransactionType: 'Payment',
      Destination: TREASURY,
      ...(intent ? { DestinationTag: intent.destinationTag } : {}),
      Amount: payCurrency === 'XRP'
        ? String(Math.round(Number(payAmount) * 1_000_000))
        : { currency: RLUSD_HEX, issuer: RLUSD_ISSUER, value: payAmount },
      Memos: [{ Memo: { MemoType: hex('xrplhub/product'), MemoData: hex(product) } }],
    }

    // Injected-wallet clients only need the txjson + treasury; skip Xaman.
    let xaman: { uuid: string; qr_png: string | null; deep_link: string | null; expires_in: number } | null = null
    if (xummConfigured()) {
      try {
        const p = await createPayload({
          txjson,
          identifier: safeIdentifier('xrplhub_', product, `_${Date.now()}`),
          blob: { productId: product, amount: payAmount, currency: payCurrency, email: email || '' },
          instruction: `XRPLHub — ${NAMES[product] || product}\nAmount: ${payAmount} ${payCurrency}\nDestination: Treasury`,
          expireMinutes: 15,
        })
        xaman = { uuid: p.uuid, qr_png: p.qrPng, deep_link: p.deepLink, expires_in: p.expiresIn }
      } catch (err) {
        if (err instanceof XummRateLimitError) {
          return NextResponse.json({ error: 'Payment gateway is busy — please retry in a moment.' }, { status: 429 })
        }
        console.error('[create-payment] Xaman error:', err)
        // fall through with txjson-only so an injected wallet can still pay
      }
    }

    return NextResponse.json({
      // Xaman fields at top level — unchanged shape for the existing flow:
      uuid:       xaman?.uuid ?? null,
      qr_png:     xaman?.qr_png ?? null,
      deep_link:  xaman?.deep_link ?? null,
      expires_in: xaman?.expires_in ?? 900,
      // Injected-wallet fields:
      txjson,
      treasury:   TREASURY,
      productLabel: NAMES[product] || product,
      // Auto-detection: poll GET /api/check-payment?intentId=... to find a manually-sent payment
      // without ever having a hash pasted in. Safe to ignore for the Xaman/injected paths.
      intentId:      intent?.id ?? null,
      destinationTag: intent?.destinationTag ?? null,
      // What the SERVER will accept — clients must charge exactly this:
      amount:     payAmount,
      currency:   payCurrency,
      priceUsd,
      xrpUsdRate,
    })
  } catch (err) {
    if (err instanceof PricingError) {
      const status = err.code === 'xrp_price_unavailable' ? 503 : 400
      return NextResponse.json({ error: err.message, code: err.code }, { status })
    }
    console.error('[create-payment]', err)
    return NextResponse.json({ error: 'Payment initialization failed. Please try again.' }, { status: 500 })
  }
}

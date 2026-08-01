// src/app/api/create-payment/route.ts
// Creates a real Xaman payment request (payload) to the XRPLHub treasury.
// Requires env vars: XUMM_API_KEY, XUMM_API_SECRET

import { NextRequest, NextResponse } from 'next/server'

const TREASURY     = 'rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF'
const XUMM_API     = 'https://xumm.app/api/v1/platform/payload'
const RLUSD_ISSUER = process.env.RLUSD_ISSUER || 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De'

// XRPL currency-code rule: 3 ASCII chars OR 40-char hex. "RLUSD" is 5 chars
// so it MUST be hex-encoded. This is the canonical encoding for RLUSD.
const RLUSD_HEX = '524C555344000000000000000000000000000000'

function toCurrencyCode(code: string): string {
  if (!code) return ''
  if (code.length === 3) return code.toUpperCase()
  if (code.length === 40 && /^[0-9A-Fa-f]+$/.test(code)) return code.toUpperCase()
  if (code.toUpperCase() === 'RLUSD') return RLUSD_HEX
  // Generic ASCII → 40-char hex pad
  const hex = Buffer.from(code, 'ascii').toString('hex').toUpperCase()
  return hex.padEnd(40, '0')
}

const NAMES: Record<string, string> = {
  multisig:'Multi-Sig Fortress', regkey:'Regular Key Rotator', depositauth:'Deposit Auth Guard',
  desttag:'Destination Tag Lock', issuerdecl:'Issuer Trustless Declaration',
  tokenfee:'Token Transfer Fee', issuercfg:'Full Issuer Config', trustline:'Trust Line Configurator',
  rippling:'Rippling Controller', dexorder:'DEX Order Builder', ammlaunch:'AMM Pool Launch',
  ammentry:'AMM Liquidity Entry', smartswap:'Smart Swap Router', paychannel:'Payment Channel',
  nftmint:'NFT Minter', nftburn:'NFT Burn Certificate', nftoffer:'NFT Offer Creator',
  identity:'On-Chain Identity', did:'DID Creator', compliance:'Compliance Bundle',
  escrow:'Escrow Setup', credit:'XRPLScore Builder',
  mptissue:'Multi-Purpose Token Issuance', mptsend:'Send MPT', trustsend:'Trust Line + Send Currency',
  globalfreeze:'Global Freeze', freezeline:'Freeze a Trust Line',
  checkcreate:'Create a Check', checkcash:'Cash a Check', checkcancel:'Cancel a Check',
  desttagreq:'Require Destination Tags', dextrade:'DEX Trade Execution', tickets:'Ticket Batch Setup',
  credentialissue:'Issue a Credential', permdomain:'Permissioned Domain',
  credential:'XRPLScore Verified Credential (90 days)',
}

export async function POST(req: NextRequest) {
  try {
    const { productId, currency, amount, email } = await req.json()

    const apiKey    = process.env.XUMM_API_KEY
    const apiSecret = process.env.XUMM_API_SECRET
    if (!apiKey || !apiSecret) {
      return NextResponse.json({ error: 'Payment gateway not configured. Contact support@xrplhub.io' }, { status: 503 })
    }

    const amtNum = parseFloat(amount)
    if (!amtNum || amtNum <= 0) {
      return NextResponse.json({ error: 'Invalid amount' }, { status: 400 })
    }

    const txjson: Record<string, unknown> = {
      TransactionType: 'Payment',
      Destination: TREASURY,
      Amount: currency === 'XRP'
        ? String(Math.round(amtNum * 1_000_000))
        : { currency: toCurrencyCode(currency || 'RLUSD'), issuer: RLUSD_ISSUER, value: String(amtNum) },
    }

    const payload = {
      txjson,
      options: { submit: true, expire: 15 },
      custom_meta: {
        identifier: `xrplhub_${productId}_${Date.now()}`,
        blob: JSON.stringify({ productId, amount: amtNum, currency, email: email || '' }),
        instruction: `XRPLHub — ${NAMES[productId] || productId}\nAmount: ${amtNum} ${currency}\nDestination: Treasury`,
      },
    }

    const res = await fetch(XUMM_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey, 'X-API-Secret': apiSecret },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    })
    const data = await res.json()

    if (!res.ok || !data?.uuid) {
      console.error('[create-payment] Xaman error:', JSON.stringify(data))
      return NextResponse.json({ error: data?.error?.reference || 'Payment gateway error. Please try again.' }, { status: 502 })
    }

    return NextResponse.json({
      uuid:       data.uuid,
      qr_png:     data.refs?.qr_png,
      deep_link:  data.next?.always,
      expires_in: 900,
    })
  } catch (err) {
    console.error('[create-payment]', err)
    return NextResponse.json({ error: 'Payment initialization failed. Please try again.' }, { status: 500 })
  }
}

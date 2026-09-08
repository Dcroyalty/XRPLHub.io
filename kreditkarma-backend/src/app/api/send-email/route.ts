import { NextRequest, NextResponse } from 'next/server'
export async function POST(req: NextRequest) {
  try {
    const { to, type, productId, txHash, amount, currency, name, wallet } = await req.json()
    if (!to || !to.includes('@')) return NextResponse.json({ ok: false, reason: 'Invalid email' }, { status: 400 })
    if (!process.env.RESEND_API_KEY) { console.warn('[Email] No RESEND_API_KEY - skipping'); return NextResponse.json({ ok: false, reason: 'Email not configured' }) }
    const subject = type === 'purchase' ? `XRPLHub — Service Activated` : `XRPLHub — Grant Application Received`
    const html = type === 'purchase'
      ? `<h2>Service Activated</h2><p>Your payment of ${amount} ${currency} has been verified on XRPL mainnet.</p><p>TX: ${txHash}</p><p><a href="https://xrpscan.com/tx/${txHash}">View on XRPScan</a></p>`
      : `<h2>Grant Application Received</h2><p>Hi ${name || 'there'}, your $${amount} grant application has been received. A person reviews every application. Please allow 24–48 hours for a decision.</p>${wallet ? `<p>Wallet: ${wallet}</p>` : ''}`
    const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.RESEND_API_KEY}` }, body: JSON.stringify({ from: 'XRPLHub <noreply@xrplhub.io>', to: [to], subject, html }) })
    const data = await res.json()
    return NextResponse.json({ ok: res.ok, id: data?.id })
  } catch (err) { console.error('[send-email]', err); return NextResponse.json({ ok: false, reason: String(err) }, { status: 500 }) }
}

// src/app/api/send-email/route.ts
// Transactional email (purchase / grant acknowledgements) via Resend.
//
// ADMIN-ONLY (ADMIN_API_TOKEN, header only). This route used to be unauthenticated: anyone could make it send
// mail from noreply@xrplhub.io to any address with attacker-chosen content. It must never be callable from a browser
// — a server-side caller passes the admin token. RESEND_API_KEY is not set today, so it also no-ops.
import { NextRequest, NextResponse } from 'next/server'
import { isAdmin, adminUnauthorized } from '@/lib/adminAuth'

/** Every caller-supplied value that reaches the HTML body is escaped: no markup injection into a message sent from our domain. */
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))

export async function POST(req: NextRequest) {
  if (!isAdmin(req)) return adminUnauthorized()
  try {
    const { to, type, txHash, amount, currency, name, wallet } = await req.json()
    if (!to || typeof to !== 'string' || !to.includes('@')) return NextResponse.json({ ok: false, reason: 'Invalid email' }, { status: 400 })
    if (!process.env.RESEND_API_KEY) { console.warn('[Email] No RESEND_API_KEY - skipping'); return NextResponse.json({ ok: false, reason: 'Email not configured' }) }
    const hash = /^[0-9A-Fa-f]{64}$/.test(String(txHash ?? '')) ? String(txHash) : ''
    const subject = type === 'purchase' ? `XRPLHub — Service Activated` : `XRPLHub — Grant Application Received`
    const html = type === 'purchase'
      ? `<h2>Service Activated</h2><p>Your payment of ${esc(amount)} ${esc(currency)} has been verified on XRPL mainnet.</p>${hash ? `<p>TX: ${hash}</p><p><a href="https://xrpscan.com/tx/${hash}">View on XRPScan</a></p>` : ''}`
      : `<h2>Grant Application Received</h2><p>Hi ${esc(name) || 'there'}, your ${esc(amount)} grant application has been received. A person reviews every application.</p>${wallet ? `<p>Wallet: ${esc(wallet)}</p>` : ''}`
    const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.RESEND_API_KEY}` }, body: JSON.stringify({ from: 'XRPLHub <noreply@xrplhub.io>', to: [to], subject, html }) })
    const data = await res.json()
    return NextResponse.json({ ok: res.ok, id: data?.id })
  } catch (err) { console.error('[send-email]', err); return NextResponse.json({ ok: false, reason: 'send failed' }, { status: 500 }) }
}

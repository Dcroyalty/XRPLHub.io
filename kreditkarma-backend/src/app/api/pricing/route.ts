// src/app/api/pricing/route.ts
// GET /api/pricing — what each storefront service costs, in the form the homepage shows it.
//
// RLUSD is the list price (USD-pegged) and comes straight from the server's price table
// (src/lib/servicePrices.ts — the same table every payment is verified against). The XRP figure
// is DERIVED here from the live XRP/USD rate; nothing stored, nothing hard-coded. If no live rate
// is available the XRP figures are null and the page shows RLUSD only — it never shows a stale
// XRP number. The exact amount a buyer is asked to pay comes from /api/create-payment (which adds a
// 2% buffer for rate drift); this endpoint is the "≈" shown on the cards.
import { NextResponse } from 'next/server';
import { SERVICE_PRICE_USD } from '@/lib/servicePrices';
import { currentXrpUsd } from '@/lib/pricing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  let rate: number | null = null;
  try {
    rate = await currentXrpUsd();
  } catch {
    rate = null;
  }
  const usd: Record<string, number> = {};
  const xrp: Record<string, number | null> = {};
  for (const [id, price] of Object.entries(SERVICE_PRICE_USD)) {
    if (id === 'credential') continue; // not a storefront card
    usd[id] = price;
    xrp[id] = rate ? Math.round((price / rate) * 10) / 10 : null;
  }
  return NextResponse.json(
    {
      xrpUsd: rate,
      asOf: new Date().toISOString(),
      usd,
      xrp,
      note: rate
        ? 'XRP figures are the RLUSD price at the live XRP/USD rate (approximate). The exact amount is quoted when you pay.'
        : 'No live XRP/USD rate is available right now — pay in RLUSD, or try again shortly.',
    },
    { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' } }
  );
}

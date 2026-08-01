// src/app/api/treasury-stats/route.ts
// Live XRPL treasury stats — matches Xaman's "available balance" exactly.

import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const TREASURY = 'rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF';
const XRPL_API = 'https://xrplcluster.com';
const XRPL_BACKUP = 'https://s1.ripple.com:51234/';

let cache: { data: object; ts: number } | null = null;
const CACHE_TTL = 300_000; // 5 min — grant count changes rarely; long TTL lets Neon compute auto-suspend

async function rpc(method: string, params: object[]): Promise<Record<string, unknown> | null> {
  for (const url of [XRPL_API, XRPL_BACKUP]) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, params }),
        signal: AbortSignal.timeout(8_000),
      });
      const json = await res.json();
      if (json?.result) return json.result as Record<string, unknown>;
    } catch { continue; }
  }
  return null;
}

// Returns the SPENDABLE balance (matches what Xaman shows).
// XRPL reserves: 1 XRP base + 0.2 XRP per owned ledger object.
async function fetchAvailableBalance(): Promise<number> {
  const r = await rpc('account_info', [{ account: TREASURY, ledger_index: 'validated' }]);
  const acc = r?.account_data as { Balance?: string; OwnerCount?: number } | undefined;
  if (!acc?.Balance) return 0;
  const totalXRP = Number(acc.Balance) / 1_000_000;
  const ownerCount = Number(acc.OwnerCount || 0);
  const reserveXRP = 1 + ownerCount * 0.2;
  return Math.max(0, totalXRP - reserveXRP);
}

async function fetchXRPPrice(): Promise<number> {
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=ripple&vs_currencies=usd',
      { signal: AbortSignal.timeout(5_000), next: { revalidate: 60 } }
    );
    const json = await res.json();
    return json?.ripple?.usd || 0.5;
  } catch { return 0.5; }
}

async function fetchInboundStats(): Promise<{ donorCount: number; paymentCount: number }> {
  const r = await rpc('account_tx', [{
    account: TREASURY, limit: 200, ledger_index_min: -1, ledger_index_max: -1,
  }]);
  const txs = (r?.transactions as Array<Record<string, unknown>> | undefined) || [];
  const senders = new Set<string>();
  let payments = 0;
  for (const item of txs) {
    const tx = item.tx as Record<string, unknown> | undefined;
    const meta = item.meta as Record<string, unknown> | undefined;
    if (!tx || !meta) continue;
    if (tx.TransactionType !== 'Payment') continue;
    if (meta.TransactionResult !== 'tesSUCCESS') continue;
    if (tx.Destination !== TREASURY) continue;
    if (typeof tx.Account === 'string') senders.add(tx.Account);
    payments++;
  }
  return { donorCount: senders.size, paymentCount: payments };
}

const fmtUSD = (n: number) =>
  n >= 1000 ? `$${(n / 1000).toFixed(1)}K` : `$${n.toFixed(2)}`;

export async function GET() {
  if (cache && Date.now() - cache.ts < CACHE_TTL) {
    return NextResponse.json(cache.data, { headers: { 'Cache-Control': 'no-store' } });
  }
  try {
    const [availXRP, xrpPrice, inbound, grantCount] = await Promise.all([
      fetchAvailableBalance(),
      fetchXRPPrice(),
      fetchInboundStats(),
      prisma.grantRequest.count({ where: { status: 'PAID' } }).catch(() => 0),
    ]);
    const payload = {
      treasuryXRP: Number(availXRP.toFixed(2)),
      treasuryUSD: fmtUSD(availXRP * xrpPrice),
      donorCount:  inbound.donorCount,
      grantCount,
      paymentCount: inbound.paymentCount,
      updatedAt:   new Date().toISOString(),
      source:      'xrpl-live',
    };
    cache = { data: payload, ts: Date.now() };
    return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error('[treasury-stats]', err);
    return NextResponse.json({
      treasuryXRP: 0, treasuryUSD: '$0.00', donorCount: 0, grantCount: 0,
      paymentCount: 0, updatedAt: new Date().toISOString(), source: 'error',
    });
  }
}

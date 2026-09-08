// src/app/api/treasury-stats/route.ts
// Live XRPL treasury stats for the public grants section.
//
// The XRPL balance is fetched on EVERY request (no cache) — it changes with
// every donation and payout and a stale number on a money page is the whole
// problem this route had before. Only the DB grant count is cached (30 min),
// because that's the sole call that would otherwise wake Neon on every hit.
//
// Numbers reported:
//   total       — the treasury's full XRP balance
//   spendable   — total minus the XRPL reserve (1 XRP base + 0.2 per owned object)
//   reserved    — the reserve itself, locked, cannot be spent
//   xrpContributed — sum of ALL successful inbound XRP Payments, full history.
//     NOT a donor head-count: most inbound "senders" sent 1–2 drops of dust.
//     A real XRP total can't be inflated by spam.
//   grantsFunded — GrantRequest rows with status 'PAID' (DB, cached)

import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

export const dynamic = 'force-dynamic';

const prisma = new PrismaClient();
const TREASURY = 'rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF';
const XRPL_API = 'https://xrplcluster.com';
const XRPL_BACKUP = 'https://s1.ripple.com:51234/';

// Cache ONLY the DB grant count — nothing that changes with the ledger.
let grantCache: { grantsFunded: number; ts: number } | null = null;
const GRANT_CACHE_TTL = 1_800_000; // 30 min — well above Neon's 5-min scale-to-zero

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

async function fetchBalances(): Promise<{ total: number; spendable: number; reserved: number } | null> {
  const r = await rpc('account_info', [{ account: TREASURY, ledger_index: 'validated' }]);
  const acc = r?.account_data as { Balance?: string; OwnerCount?: number } | undefined;
  if (!acc?.Balance) return null;
  const total = Number(acc.Balance) / 1_000_000;
  const reserved = 1 + Number(acc.OwnerCount || 0) * 0.2;
  return { total, spendable: Math.max(0, total - reserved), reserved };
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

// Sum of every successful inbound XRP Payment, full history (the treasury has
// ~130 txs total — one page covers it; if that ever changes, add pagination).
async function fetchXrpContributed(): Promise<{ xrpContributed: number; paymentCount: number }> {
  const r = await rpc('account_tx', [{
    account: TREASURY, limit: 200, ledger_index_min: -1, ledger_index_max: -1,
  }]);
  const txs = (r?.transactions as Array<Record<string, unknown>> | undefined) || [];
  let sum = 0;
  let payments = 0;
  for (const item of txs) {
    const tx = (item.tx ?? item.tx_json) as Record<string, unknown> | undefined;
    const meta = item.meta as Record<string, unknown> | undefined;
    if (!tx || !meta) continue;
    if (tx.TransactionType !== 'Payment') continue;
    if (meta.TransactionResult !== 'tesSUCCESS') continue;
    if (tx.Destination !== TREASURY) continue;
    if (typeof tx.Amount !== 'string') continue; // XRP amounts are drop strings
    sum += Number(tx.Amount) / 1_000_000;
    payments++;
  }
  return { xrpContributed: sum, paymentCount: payments };
}

async function grantsFunded(): Promise<number> {
  if (grantCache && Date.now() - grantCache.ts < GRANT_CACHE_TTL) return grantCache.grantsFunded;
  const n = await prisma.grantRequest.count({ where: { status: 'PAID' } }).catch(() => grantCache?.grantsFunded ?? 0);
  grantCache = { grantsFunded: n, ts: Date.now() };
  return n;
}

const fmtUSD = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(1)}K` : `$${n.toFixed(2)}`);

export async function GET() {
  try {
    const [bal, xrpPrice, contributed, funded] = await Promise.all([
      fetchBalances(),
      fetchXRPPrice(),
      fetchXrpContributed(),
      grantsFunded(),
    ]);
    if (!bal) throw new Error('could not read treasury balance');

    const payload = {
      totalXRP: Number(bal.total.toFixed(6)),
      spendableXRP: Number(bal.spendable.toFixed(6)),
      reservedXRP: Number(bal.reserved.toFixed(2)),
      totalUSD: fmtUSD(bal.total * xrpPrice),
      xrpContributed: Number(contributed.xrpContributed.toFixed(2)),
      contributionCount: contributed.paymentCount,
      grantsFunded: funded,
      updatedAt: new Date().toISOString(),
      source: 'xrpl-live',
    };
    return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error('[treasury-stats]', err);
    return NextResponse.json({
      totalXRP: 0, spendableXRP: 0, reservedXRP: 0, totalUSD: '$0.00',
      xrpContributed: 0, contributionCount: 0, grantsFunded: grantCache?.grantsFunded ?? 0,
      updatedAt: new Date().toISOString(), source: 'error',
    }, { headers: { 'Cache-Control': 'no-store' } });
  }
}

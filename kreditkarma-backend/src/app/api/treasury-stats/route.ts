// src/app/api/treasury-stats/route.ts
// Live XRPL treasury stats for the public grants section.
//
// The XRPL balance is fetched on EVERY request (no cache) — it changes with every donation
// and payout and a stale number on a money page is the whole problem this route had before.
// The full-history inbound aggregate is cached for a few minutes (it only ever grows) and the
// grant counts for a few minutes (they are the only DB call that would wake Neon on every hit).
//
// Numbers reported:
//   totalXRP / spendableXRP / reservedXRP — the treasury balance and the XRPL account reserve
//     (1 XRP base + 0.2 per owned object); the reserve is locked and cannot be spent.
//   Inbound XRP payments, FULL history (paginated — it used to read only the first 200
//   transactions and would have silently undercounted past that), split three ways:
//     external  — from wallets that are not XRPLHub's own and not dust  (what the page shows as "received")
//     internal  — from XRPLHub's own operator wallets (transfers and tests); NOT contributions
//     dust      — under 0.01 XRP, i.e. spam
//   "external" is still every inbound payment from an outside wallet — a donation OR a purchase —
//   because the chain can't tell them apart; the page says so.
//   totalUSD — the balance at the live XRP/USD rate, or null when no live rate is available. It
//     never falls back to an assumed price (it used to assume $0.50 without saying so).
//   grantsPaid / grantsPaidTotals / grantsAwaitingFunds — GrantRequest rows (DB, cached).

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { xrplRpc } from '@/lib/xrplNodes';
import { currentXrpUsd } from '@/lib/pricing';

export const dynamic = 'force-dynamic';

const TREASURY = 'rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF';

/** XRPLHub's own wallets — confirmed by the operator. Inbound from these is internal, not a contribution. */
const OPERATOR_WALLETS: ReadonlySet<string> = new Set([
  'rKM3a1zj7w3i9BiEpsvXEqjozYdqjt8SdY',
  'rPVW5ce1MgkmBwuPT8Ummrw39CzeiERjXL',
  ...(process.env.OPERATOR_WALLETS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
]);
const DUST_XRP = 0.01;
const PAGE_LIMIT = 200;
const MAX_PAGES = 25; // 5,000 transactions

const HISTORY_TTL_MS = 5 * 60_000;
const GRANT_TTL_MS = 5 * 60_000;

interface Bucket { n: number; xrp: number }
interface History {
  all: Bucket; external: Bucket; internal: Bucket; dust: Bucket;
  /** false = more history exists than we paged through (the numbers are a floor) */
  complete: boolean;
  at: number;
}
let historyCache: History | null = null;
let grantCache: { paid: number; totals: { currency: string; amount: number }[]; awaiting: number; at: number } | null = null;

async function rpc(method: string, params: object): Promise<Record<string, unknown> | null> {
  const r = await xrplRpc(method, params);
  return r.ok ? ((r.body.result as Record<string, unknown> | undefined) ?? null) : null;
}

async function fetchBalances(): Promise<{ total: number; spendable: number; reserved: number } | null> {
  const r = await rpc('account_info', { account: TREASURY, ledger_index: 'validated' });
  const acc = r?.account_data as { Balance?: string; OwnerCount?: number } | undefined;
  if (!acc?.Balance) return null;
  const total = Number(acc.Balance) / 1_000_000;
  const reserved = 1 + Number(acc.OwnerCount || 0) * 0.2;
  return { total, spendable: Math.max(0, total - reserved), reserved };
}

/** Walk the treasury's whole transaction history and bucket every successful inbound XRP Payment. */
async function fetchInboundHistory(): Promise<History | null> {
  if (historyCache && Date.now() - historyCache.at < HISTORY_TTL_MS) return historyCache;
  const h: History = { all: { n: 0, xrp: 0 }, external: { n: 0, xrp: 0 }, internal: { n: 0, xrp: 0 }, dust: { n: 0, xrp: 0 }, complete: true, at: Date.now() };
  let marker: unknown;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await rpc('account_tx', {
      account: TREASURY, limit: PAGE_LIMIT, ledger_index_min: -1, ledger_index_max: -1, ...(marker ? { marker } : {}),
    });
    const txs = r?.transactions as Array<Record<string, unknown>> | undefined;
    if (!txs) return historyCache; // ledger unreachable: keep serving the last good aggregate (or null)
    for (const item of txs) {
      const tx = (item.tx ?? item.tx_json) as Record<string, unknown> | undefined;
      const meta = item.meta as Record<string, unknown> | undefined;
      if (!tx || !meta) continue;
      if (tx.TransactionType !== 'Payment' || meta.TransactionResult !== 'tesSUCCESS' || tx.Destination !== TREASURY) continue;
      if (typeof tx.Amount !== 'string') continue; // XRP amounts are drop strings
      const xrp = Number(tx.Amount) / 1_000_000;
      const bucket = OPERATOR_WALLETS.has(String(tx.Account)) ? h.internal : xrp < DUST_XRP ? h.dust : h.external;
      bucket.n++; bucket.xrp += xrp;
      h.all.n++; h.all.xrp += xrp;
    }
    marker = r?.marker;
    if (!marker) break;
    if (page === MAX_PAGES - 1) h.complete = false;
  }
  historyCache = h;
  return h;
}

async function grantStats() {
  if (grantCache && Date.now() - grantCache.at < GRANT_TTL_MS) return grantCache;
  try {
    const [paid, sums, awaiting] = await Promise.all([
      db.grantRequest.count({ where: { status: 'PAID' } }),
      db.grantRequest.groupBy({ by: ['currency'], where: { status: 'PAID' }, _sum: { paidAmount: true } }),
      db.grantRequest.count({ where: { status: 'APPROVED' } }),
    ]);
    grantCache = {
      paid,
      totals: sums.map((s) => ({ currency: s.currency, amount: Number(s._sum.paidAmount ?? 0) })).filter((s) => s.amount > 0),
      awaiting,
      at: Date.now(),
    };
  } catch {
    // DB unreachable: serve the last good numbers if we have them; otherwise say "unknown" (null), never 0
    if (!grantCache) return null;
  }
  return grantCache;
}

const r2 = (n: number) => Number(n.toFixed(2));
const fmtUSD = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(1)}K` : `$${n.toFixed(2)}`);

export async function GET() {
  try {
    const [bal, history, grants] = await Promise.all([fetchBalances(), fetchInboundHistory(), grantStats()]);
    if (!bal) throw new Error('could not read treasury balance');

    let totalUSD: string | null = null;
    try {
      totalUSD = fmtUSD(bal.total * (await currentXrpUsd()));
    } catch {
      totalUSD = null; // no live rate: say nothing rather than guess
    }

    return NextResponse.json({
      totalXRP: Number(bal.total.toFixed(6)),
      spendableXRP: Number(bal.spendable.toFixed(6)),
      reservedXRP: Number(bal.reserved.toFixed(2)),
      totalUSD,
      // inbound XRP, full history
      xrpReceivedExternal: history ? r2(history.external.xrp) : null,
      externalPayments: history?.external.n ?? null,
      xrpReceivedInternal: history ? r2(history.internal.xrp) : null,
      internalPayments: history?.internal.n ?? null,
      xrpReceivedDust: history ? Number(history.dust.xrp.toFixed(6)) : null,
      dustPayments: history?.dust.n ?? null,
      xrpReceivedAll: history ? r2(history.all.xrp) : null,
      historyComplete: history?.complete ?? null,
      // grants
      grantsPaid: grants?.paid ?? null,
      grantsPaidTotals: grants?.totals ?? null,
      grantsAwaitingFunds: grants?.awaiting ?? null,
      updatedAt: new Date().toISOString(),
      source: 'xrpl-live',
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error('[treasury-stats]', err);
    return NextResponse.json({ source: 'error', updatedAt: new Date().toISOString() }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}

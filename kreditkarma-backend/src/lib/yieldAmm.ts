// src/lib/yieldAmm.ts — XRPL AMM pools for the XRP Yield Desk: size from amm_info, fee income from trades.
//
// Fee income is built from the ledger itself. Every successful Payment or OfferCreate that moves the pool's
// XRP balance is a trade through the pool; the pool keeps TradingFee (in 1/100,000) of the amount traded, so
// fees ≈ |change in the pool's XRP| × TradingFee, in XRP terms whichever way the trade went. Deposits,
// withdrawals, votes and bids (AMM* transactions) are not trades and are skipped. This slightly overstates
// fees when the auction-slot holder trades (it pays a tenth of the fee) — the page says the rate is approximate.
//
// The scan is incremental and resumable: each pool's position is an IndexerCheckpoint (`yield-amm:<account>`)
// holding the ledger to start from and rippled's paging marker. The first run starts 7 days back; later runs
// read only what is new (about one page an hour for the busiest pool). Fees are summed per UTC day in
// YieldAmmDay. Rate = fees over the covered window (up to the last 7 days), annualized, ÷ pool value (2 × its XRP).
import type { PrismaClient } from "@prisma/client";
import { xrplRpc } from "./xrplNodes";
import type { SourceItem } from "./yieldSources";

const RIPPLE_EPOCH = 946_684_800;
const LEDGERS_PER_DAY = 22_000; // ~3.9s per ledger; only used to pick the first scan's starting ledger
const NOT_TRADES = new Set(["AMMCreate", "AMMDeposit", "AMMWithdraw", "AMMVote", "AMMBid", "AMMDelete", "AMMClawback"]);
const MIN_POOL_USD = 250_000;

// XRP pools against major stablecoins. Issuers checked on the ledger (Domain field): RLUSD → ripple.com,
// USDC → circle.com. Pools under $250K are not listed.
export const AMM_POOLS = [
  { pair: "XRP/RLUSD", other: "RLUSD", currency: "524C555344000000000000000000000000000000", issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De" },
  { pair: "XRP/USDC", other: "USDC", currency: "5553444300000000000000000000000000000000", issuer: "rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE" },
] as const;

type Rpc = (method: string, params: object) => Promise<Record<string, unknown> | null>;
// Ripple's own full-history servers first: the community pool often answers account_tx and amm_info with
// "tooBusy"/"slowDown" inside a normal reply. A reply carrying an error counts as a failure, never as data.
const DIRECT = ["https://s1.ripple.com:51234", "https://s2.ripple.com:51234"];
const usable = (r: Record<string, unknown> | null | undefined) => (r && !r.error ? r : null);
const defaultRpc: Rpc = async (method, params) => {
  for (const url of DIRECT) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params: [params] }), signal: AbortSignal.timeout(12_000), cache: "no-store" });
      const r = usable(((await res.json()) as { result?: Record<string, unknown> }).result);
      if (r) return r;
    } catch { /* next */ }
  }
  const r = await xrplRpc(method, params, 12_000);
  return r.ok ? usable(r.body.result as Record<string, unknown>) : null;
};

type Cursor = { min: number; marker: unknown | null };
const dayOf = (unixSec: number) => new Date(Math.floor(unixSec / 86_400) * 86_400_000);

/** One page of trades for one pool. Returns false when the pool is caught up (or the read failed). */
async function scanPage(prisma: PrismaClient, amm: string, feeUnits: number, rpc: Rpc): Promise<boolean> {
  const id = `yield-amm:${amm}`;
  const cp = await prisma.indexerCheckpoint.findUnique({ where: { id } });
  let cursor: Cursor;
  if (cp?.marker) cursor = JSON.parse(cp.marker) as Cursor;
  else {
    const v = await rpc("ledger", { ledger_index: "validated" });
    const idx = Number((v?.ledger as { ledger_index?: string | number } | undefined)?.ledger_index ?? (v as { ledger_index?: number } | null)?.ledger_index);
    if (!Number.isFinite(idx)) return false;
    cursor = { min: idx - 7 * LEDGERS_PER_DAY, marker: null };
    await prisma.indexerCheckpoint.upsert({ where: { id }, create: { id, status: "running", marker: JSON.stringify(cursor), passStartedAt: new Date() }, update: { marker: JSON.stringify(cursor), passStartedAt: new Date() } });
  }
  const r = await rpc("account_tx", { account: amm, ledger_index_min: cursor.min, ledger_index_max: -1, forward: true, limit: 400, ...(cursor.marker ? { marker: cursor.marker } : {}) });
  const txs = r?.transactions as { meta?: Record<string, unknown>; tx_json?: Record<string, unknown>; tx?: Record<string, unknown>; ledger_index?: number; close_time_iso?: string }[] | undefined;
  if (!r || !Array.isArray(txs)) return false;

  const byDay = new Map<number, { fees: number; trades: number }>();
  let maxLedger = cursor.min - 1;
  let lastClose: number | null = null;
  for (const t of txs) {
    const tx = t.tx_json ?? t.tx ?? {};
    const meta = t.meta as { TransactionResult?: string; AffectedNodes?: { ModifiedNode?: { LedgerEntryType?: string; FinalFields?: { Account?: string; Balance?: string }; PreviousFields?: { Balance?: string } } }[] } | undefined;
    const ledger = Number(t.ledger_index ?? tx.ledger_index);
    if (Number.isFinite(ledger)) maxLedger = Math.max(maxLedger, ledger);
    const close = t.close_time_iso ? Date.parse(t.close_time_iso) / 1000 : typeof tx.date === "number" ? (tx.date as number) + RIPPLE_EPOCH : null;
    if (close) lastClose = close;
    if (!meta || meta.TransactionResult !== "tesSUCCESS" || NOT_TRADES.has(String(tx.TransactionType)) || !close) continue;
    for (const n of meta.AffectedNodes ?? []) {
      const m = n.ModifiedNode;
      if (m?.LedgerEntryType !== "AccountRoot" || m.FinalFields?.Account !== amm || m.PreviousFields?.Balance == null) continue;
      const moved = Math.abs(Number(m.FinalFields.Balance) - Number(m.PreviousFields.Balance)) / 1e6;
      const key = dayOf(close).getTime();
      const b = byDay.get(key) ?? { fees: 0, trades: 0 };
      b.fees += (moved * feeUnits) / 100_000;
      b.trades += 1;
      byDay.set(key, b);
    }
  }
  const marker = (r.marker as unknown) ?? null;
  const next: Cursor = marker ? { min: cursor.min, marker } : { min: Math.max(cursor.min, maxLedger + 1), marker: null };
  await prisma.$transaction([
    ...[...byDay].map(([day, b]) =>
      prisma.yieldAmmDay.upsert({
        where: { amm_day: { amm, day: new Date(day) } },
        create: { amm, day: new Date(day), feesXrp: b.fees, trades: b.trades },
        update: { feesXrp: { increment: b.fees }, trades: { increment: b.trades } },
      })
    ),
    prisma.indexerCheckpoint.update({
      where: { id },
      data: { marker: JSON.stringify(next), status: marker ? "running" : "idle", lastLedgerCloseTime: lastClose ? Math.round(lastClose) : cp?.lastLedgerCloseTime ?? undefined, ...(marker ? {} : { lastCompletedPassAt: new Date() }) },
    }),
  ]);
  return Boolean(marker);
}

/** The pool's first transaction (its creation), as an ISO date. */
async function poolCreatedAt(amm: string, rpc: Rpc): Promise<string | null> {
  const r = await rpc("account_tx", { account: amm, limit: 1, forward: true });
  const t = (r?.transactions as { close_time_iso?: string; tx_json?: { date?: number }; tx?: { date?: number } }[] | undefined)?.[0];
  if (!t) return null;
  if (t.close_time_iso) return new Date(t.close_time_iso).toISOString();
  const d = t.tx_json?.date ?? t.tx?.date;
  return typeof d === "number" ? new Date((d + RIPPLE_EPOCH) * 1000).toISOString() : null;
}

export async function ammSource(
  prisma: PrismaClient,
  opts: { xrpUsd: number; deadline: number; knownLaunch: Record<string, string | null>; rpc?: Rpc }
): Promise<{ name: string; items: SourceItem[]; keep: string[] }> {
  const rpc = opts.rpc ?? defaultRpc;
  const items: SourceItem[] = [];
  const errors: string[] = [];
  const keep: string[] = [];
  for (const p of AMM_POOLS) {
    // One pool failing (a node hiccup) must not hide the others: retry once, then skip it this run.
    let amm: { account: string; amount: string; amount2: { value: string }; trading_fee: number } | undefined;
    for (let attempt = 0; attempt < 2 && !amm; attempt++) {
      const info = await rpc("amm_info", { asset: { currency: "XRP" }, asset2: { currency: p.currency, issuer: p.issuer } }).catch(() => null);
      amm = info?.amm as typeof amm;
    }
    if (!amm) {
      errors.push(`amm_info failed for ${p.pair}`);
      keep.push(`xrpl-amm-${p.pair.toLowerCase().replace("/", "-")}`);
      continue;
    }
    const xrp = Number(amm.amount) / 1e6;
    const poolUsd = 2 * xrp * opts.xrpUsd;
    if (poolUsd < MIN_POOL_USD) continue;

    // Catch up on trades while time allows (the rest continues next run).
    while (Date.now() < opts.deadline - 4_000) {
      const more = await scanPage(prisma, amm.account, amm.trading_fee, rpc).catch(() => false);
      if (!more) break;
    }
    const cp = await prisma.indexerCheckpoint.findUnique({ where: { id: `yield-amm:${amm.account}` } });
    const startedAt = cp?.passStartedAt?.getTime() ?? Date.now();
    const lastClose = cp?.lastLedgerCloseTime ? cp.lastLedgerCloseTime * 1000 : null;
    // Window: whole UTC days only, from the later of (scan start, 7 days ago), up to the last trade we read.
    const windowStart = Math.ceil(Math.max(startedAt - 7 * 86_400_000, Date.now() - 7 * 86_400_000) / 86_400_000) * 86_400_000;
    let rate: number | null = null;
    let spanDays = 0;
    if (lastClose && lastClose > windowStart) {
      spanDays = (lastClose - windowStart) / 86_400_000;
      const rows = await prisma.yieldAmmDay.findMany({ where: { amm: amm.account, day: { gte: new Date(windowStart) } } });
      const fees = rows.reduce((s, r) => s + r.feesXrp, 0);
      if (spanDays >= 1) rate = (fees * 365) / spanDays / (2 * xrp);
    }
    const slug = `xrpl-amm-${p.pair.toLowerCase().replace("/", "-")}`;
    const launchedAt = opts.knownLaunch[slug] ?? (await poolCreatedAt(amm.account, rpc).catch(() => null));
    items.push({
      option: {
        slug,
        name: `XRPL AMM pool ${p.pair}`,
        provider: "XRP Ledger AMM",
        asset: "XRP",
        kind: "amm",
        chain: "XRP Ledger",
        rate,
        rateBase: rate,
        rateReward: null,
        rateKind: rate == null
          ? "still reading trades from the ledger — the fee rate appears once we have a full day"
          : `trading-fee income over the last ${spanDays >= 6.5 ? 7 : Math.floor(spanDays)} day${Math.floor(spanDays) === 1 ? "" : "s"}, from on-ledger trades (approximate)`,
        tvlUsd: poolUsd,
        lockup: "None.",
        withdrawal: "Withdraw any time in one transaction. You get back XRP and " + p.other + " in whatever mix the pool holds then.",
        withdrawShort: "any time",
        keys: "You do: your share of the pool (LP tokens) sits in your own XRPL wallet. The pool is part of the XRP Ledger itself.",
        custody: "self",
        bridge: "none",
        layers: 0,
        launchedAt,
        audits: null,
        auditLinks: [],
        ilRisk: true,
        url: `https://xrpscan.com/account/${amm.account}`,
        source: { name: "XRP Ledger (amm_info and the pool's trades)", url: `https://xrpscan.com/account/${amm.account}`, at: new Date().toISOString() },
        notes: [
          `Trading fee: ${(amm.trading_fee / 1000).toFixed(3)}% of each trade, set by a vote of the pool's liquidity providers.`,
          `Pool holds ${Math.round(xrp).toLocaleString("en-US")} XRP and ${Math.round(Number(amm.amount2.value)).toLocaleString("en-US")} ${p.other}.`,
          "The rate counts trading fees only. Price moves between XRP and " + p.other + " (impermanent loss) can outweigh them.",
        ],
      },
      extra: { amm: amm.account, tradingFee: amm.trading_fee, xrp, spanDays: Math.round(spanDays * 10) / 10 },
    });
  }
  if (!items.length && errors.length) throw new Error(errors.join("; "));
  return { name: "xrpl-amm", items, keep };
}

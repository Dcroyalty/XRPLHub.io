// src/lib/grantsPool.ts — the XRPLHub grants pool, read from the XRP Ledger.
//
// The pool is raiqAnACKxmVY7oCUWnCYdGquSrkMdsMuu. Its keys live only in the owner's Xaman wallet: XRPLHub never
// holds them and nothing here can move money. We only READ: the balance, whether it has an RLUSD trust line (the
// RLUSD donation option appears by itself once it does), and every payment in (a donation) and out (a grant) from
// 2026-10-16 on — the account's earlier test history is left out on purpose.
//
// Card donations are taken by Morrbiz LLC's Stripe account on uxus.finance (GET /api/grants/card-donations) and
// merged in for the public list and the yearly total. Once total donations in a calendar year pass $20,000 we send
// ONE healthchecks.io /fail alert (checkpoint `grants-donations-alert:<year>`), so the owner can sort out
// Pennsylvania charitable-solicitation registration before the $25,000 threshold.
import type { PrismaClient } from "@prisma/client";
import { xrpUsd } from "./xrpPrice";
import { pingHealthcheck } from "./notify";
import { GRANTS_POOL, FIRST_MILESTONE_XRP, FIRST_MILESTONE_GRANTS } from "./grantsCopy";
export * from "./grantsCopy";


export const POOL_HISTORY_FROM = new Date("2026-10-16T00:00:00Z");
const START_LEDGER = 107_680_000; // a little before 2026-10-16 00:00 UTC; the date filter does the exact cut



export const DONATIONS_ALERT_USD = 20_000;
const RLUSD_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
const RLUSD_HEX = "524C555344000000000000000000000000000000";
const RIPPLE_EPOCH = 946_684_800;
const NODES = ["https://s1.ripple.com:51234", "https://s2.ripple.com:51234", "https://xrplcluster.com"];
const CARD_DONATIONS_URL = "https://uxus.finance/api/grants/card-donations";




async function rpc(method: string, params: object): Promise<Record<string, unknown> | null> {
  for (const url of NODES) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params: [params] }), signal: AbortSignal.timeout(10_000), cache: "no-store" });
      const j = (await r.json()) as { result?: Record<string, unknown> };
      if (j.result && !j.result.error) return j.result;
      if (j.result?.error === "actNotFound") return j.result;
    } catch { /* next node */ }
  }
  return null;
}

export interface PoolState { balanceXrp: number | null; rlusd: { enabled: boolean; balance: number }; readAt: string }

/** Live pool state from the ledger. RLUSD donations are offered only when the trust line exists. */
export async function readPool(): Promise<PoolState> {
  const [info, lines] = await Promise.all([
    rpc("account_info", { account: GRANTS_POOL, ledger_index: "validated" }),
    rpc("account_lines", { account: GRANTS_POOL, peer: RLUSD_ISSUER, ledger_index: "validated" }),
  ]);
  const bal = (info?.account_data as { Balance?: string } | undefined)?.Balance;
  const line = ((lines?.lines as { currency: string; account: string; balance: string }[] | undefined) ?? []).find((l) => l.currency === RLUSD_HEX && l.account === RLUSD_ISSUER);
  return { balanceXrp: bal != null ? Number(bal) / 1e6 : null, rlusd: { enabled: !!line, balance: line ? Number(line.balance) : 0 }, readAt: new Date().toISOString() };
}

type Amount = string | { currency: string; issuer: string; value: string };
function parseAmount(a: Amount | undefined): { currency: "XRP" | "RLUSD"; amount: number } | null {
  if (a == null) return null;
  if (typeof a === "string") return { currency: "XRP", amount: Number(a) / 1e6 };
  if (a.currency === RLUSD_HEX && a.issuer === RLUSD_ISSUER) return { currency: "RLUSD", amount: Number(a.value) };
  return null; // other tokens aren't counted as donations
}

/** Read new pool payments from the ledger into GrantsLedgerEntry (incremental; checkpoint `grants-pool-scan`). */
export async function syncPoolLedger(prisma: PrismaClient, deadline = Date.now() + 25_000): Promise<{ added: number }> {
  const cp = await prisma.indexerCheckpoint.findUnique({ where: { id: "grants-pool-scan" } });
  let min = cp?.lastLedgerCloseTime ?? START_LEDGER; // here: the next ledger index to read from
  let marker: unknown = cp?.marker ? JSON.parse(cp.marker) : undefined;
  let added = 0;
  let price: number | null = null;
  while (Date.now() < deadline) {
    const r = await rpc("account_tx", { account: GRANTS_POOL, ledger_index_min: min, ledger_index_max: -1, forward: true, limit: 200, ...(marker ? { marker } : {}) });
    if (!r) throw new Error("couldn't read the grants pool's transactions from the ledger");
    const txs = (r.transactions as { tx_json?: Record<string, unknown>; tx?: Record<string, unknown>; meta?: Record<string, unknown>; ledger_index?: number; hash?: string; validated?: boolean }[]) ?? [];
    let maxLedger = min - 1;
    for (const t of txs) {
      const tx = t.tx_json ?? t.tx ?? {};
      const ledgerIndex = Number(t.ledger_index ?? tx.ledger_index);
      maxLedger = Math.max(maxLedger, ledgerIndex);
      const meta = t.meta as { TransactionResult?: string; delivered_amount?: Amount } | undefined;
      if (tx.TransactionType !== "Payment" || meta?.TransactionResult !== "tesSUCCESS") continue;
      const at = new Date((Number(tx.date) + RIPPLE_EPOCH) * 1000);
      if (at < POOL_HISTORY_FROM) continue;
      const amt = parseAmount(meta.delivered_amount);
      if (!amt) continue;
      const incoming = tx.Destination === GRANTS_POOL && tx.Account !== GRANTS_POOL;
      const outgoing = tx.Account === GRANTS_POOL && tx.Destination !== GRANTS_POOL;
      if (!incoming && !outgoing) continue;
      const hash = String(t.hash ?? tx.hash ?? "");
      if (!hash) continue;
      if (amt.currency === "XRP" && price == null) price = await xrpUsd().catch(() => null);
      const usdValue = amt.currency === "RLUSD" ? amt.amount : price != null ? amt.amount * price : null;
      const res = await prisma.grantsLedgerEntry.upsert({
        where: { txHash: hash },
        create: { txHash: hash, direction: incoming ? "in" : "out", counterparty: String(incoming ? tx.Account : tx.Destination), currency: amt.currency, amount: amt.amount, usdValue, ledgerIndex, at },
        update: {},
      });
      if (res) added++;
    }
    marker = r.marker ?? undefined;
    if (!marker) {
      min = Math.max(min, maxLedger + 1);
      await prisma.indexerCheckpoint.upsert({ where: { id: "grants-pool-scan" }, create: { id: "grants-pool-scan", status: "idle", lastLedgerCloseTime: min, lastCompletedPassAt: new Date() }, update: { status: "idle", marker: null, lastLedgerCloseTime: min, lastCompletedPassAt: new Date() } });
      break;
    }
    await prisma.indexerCheckpoint.upsert({ where: { id: "grants-pool-scan" }, create: { id: "grants-pool-scan", status: "running", marker: JSON.stringify(marker), lastLedgerCloseTime: min }, update: { status: "running", marker: JSON.stringify(marker), lastLedgerCloseTime: min } });
  }
  return { added };
}

export interface CardDonation { id: string; amount_usd: number; fee_usd: number | null; net_usd: number | null; received_at: string }

export async function cardDonations(): Promise<CardDonation[] | null> {
  try {
    const r = await fetch(CARD_DONATIONS_URL, { signal: AbortSignal.timeout(8_000), next: { revalidate: 120 } });
    if (!r.ok) return null;
    return ((await r.json()) as { donations?: CardDonation[] }).donations ?? [];
  } catch {
    return null;
  }
}

/** Total donations (USD) received in a calendar year: card (gross) + XRP and RLUSD (valued when received). */
export async function donationsUsdInYear(prisma: PrismaClient, year: number, cards: CardDonation[] | null): Promise<{ total: number; ledger: number; card: number; cardKnown: boolean }> {
  const from = new Date(Date.UTC(year, 0, 1)), to = new Date(Date.UTC(year + 1, 0, 1));
  // Transfers of card donations from the XRPLHub treasury are not new donations (the card amount is already counted).
  const rows = await prisma.grantsLedgerEntry.findMany({ where: { direction: "in", at: { gte: from, lt: to }, counterparty: { notIn: NOT_DONATION_SOURCES } }, select: { usdValue: true } });
  const ledger = rows.reduce((s, r) => s + (r.usdValue ?? 0), 0);
  const card = (cards ?? []).filter((c) => { const t = Date.parse(c.received_at); return t >= from.getTime() && t < to.getTime(); }).reduce((s, c) => s + c.amount_usd, 0);
  return { total: ledger + card, ledger, card, cardKnown: cards != null };
}

/** ONE healthchecks.io /fail alert per calendar year once donations pass $20,000. */
export async function maybeDonationsAlert(prisma: PrismaClient, ping: typeof pingHealthcheck = pingHealthcheck): Promise<boolean> {
  const year = new Date().getUTCFullYear();
  const id = `grants-donations-alert:${year}`;
  if (await prisma.indexerCheckpoint.findUnique({ where: { id } })) return false;
  const t = await donationsUsdInYear(prisma, year, await cardDonations());
  if (t.total <= DONATIONS_ALERT_USD) return false;
  await prisma.indexerCheckpoint.create({ data: { id, status: "idle", lastCompletedPassAt: new Date() } });
  await ping("/fail", `XRPLHub grants pool: donations in ${year} have passed $${DONATIONS_ALERT_USD.toLocaleString("en-US")} ($${Math.round(t.total).toLocaleString("en-US")}: card $${Math.round(t.card).toLocaleString("en-US")}, XRP/RLUSD $${Math.round(t.ledger).toLocaleString("en-US")}). Sort out Pennsylvania charitable-solicitation registration before $25,000. This alert is sent once per year.`);
  return true;
}


// ── Card donations owed to the pool ────────────────────────────────────────────────────────────────────────────
// Card donations land in Morrbiz LLC's Stripe balance. The owner moves them into the pool by paying it from the
// XRPLHub treasury (rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF), as RLUSD at 1 RLUSD per dollar. Those payments are transfers, not new donations: they are
// left out of the donation totals and matched to card donations oldest-first by USD value (net of card fees when the
// fee is known). A card donation counts as moved on the date the transfer that covers it arrived. If one sits
// unmoved for 30 days we send ONE healthchecks.io /fail alert for it (checkpoint `grants-card-unmoved:<ref>`).
export const CARD_TRANSFER_SOURCE = "rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF";
// The owner's own wallets (owner, 2026-10-16): payments into the pool from these are top-ups (e.g. reserve), never
// donations. The treasury above counts only as moving card donations.
export const OWNER_TOPUP_SOURCES = ["rKM3a1zj7w3i9BiEpsvXEqjozYdqjt8SdY"];
export const NOT_DONATION_SOURCES = [CARD_TRANSFER_SOURCE, ...OWNER_TOPUP_SOURCES];

export interface CardOwed { id: string; receivedAt: string; owedUsd: number; movedAt: string | null }

export function allocateCardTransfers(cards: CardDonation[], transfers: { at: Date; usdValue: number | null }[]): { rows: CardOwed[]; owedUsd: number } {
  const queue = [...transfers].sort((a, b) => a.at.getTime() - b.at.getTime()).map((t) => ({ at: t.at, left: t.usdValue ?? 0 }));
  const rows: CardOwed[] = [];
  let owedTotal = 0;
  for (const c of [...cards].sort((a, b) => a.received_at.localeCompare(b.received_at))) {
    const owed = c.net_usd ?? c.amount_usd;
    let need = owed;
    let movedAt: Date | null = null;
    while (need > 0.005 && queue.length) {
      const t = queue[0];
      const take = Math.min(t.left, need);
      t.left -= take; need -= take; movedAt = t.at;
      if (t.left <= 0.005) queue.shift();
    }
    const moved = need <= 0.005;
    if (!moved) owedTotal += need;
    rows.push({ id: c.id, receivedAt: c.received_at, owedUsd: owed, movedAt: moved && movedAt ? movedAt.toISOString() : null });
  }
  return { rows, owedUsd: owedTotal };
}

export async function cardOwed(prisma: PrismaClient, cards: CardDonation[]): Promise<{ rows: CardOwed[]; owedUsd: number }> {
  const transfers = await prisma.grantsLedgerEntry.findMany({ where: { direction: "in", counterparty: CARD_TRANSFER_SOURCE }, select: { at: true, usdValue: true } });
  return allocateCardTransfers(cards, transfers);
}

export async function maybeCardUnmovedAlert(prisma: PrismaClient, ping: typeof pingHealthcheck = pingHealthcheck): Promise<number> {
  const cards = await cardDonations();
  if (!cards?.length) return 0;
  const { rows } = await cardOwed(prisma, cards);
  const late = rows.filter((r) => !r.movedAt && Date.now() - Date.parse(r.receivedAt) > 30 * 86_400_000);
  const fresh: CardOwed[] = [];
  for (const r of late) {
    const id = `grants-card-unmoved:${r.id}`;
    if (await prisma.indexerCheckpoint.findUnique({ where: { id } })) continue;
    await prisma.indexerCheckpoint.create({ data: { id, status: "idle", lastCompletedPassAt: new Date() } });
    fresh.push(r);
  }
  if (fresh.length) {
    await ping("/fail", `XRPLHub grants pool: ${fresh.length} card donation(s) received over 30 days ago are still not moved to the pool: ${fresh.map((r) => `$${r.owedUsd.toFixed(2)} (ref …${r.id}, received ${r.receivedAt.slice(0, 10)})`).join("; ")}. Send the amount as RLUSD (1 RLUSD per dollar) from the XRPLHub treasury ${CARD_TRANSFER_SOURCE} to ${GRANTS_POOL}. One alert per donation.`);
  }
  return fresh.length;
}

/** Grants approved before the pool existed (July 2026): first in the queue, paid from the first donations. */
export async function paidFirstGrants(prisma: PrismaClient) {
  return prisma.grantRequest.findMany({
    where: { round: "paid-first", status: "APPROVED", paidAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, walletAddress: true, approvedAmount: true, currency: true, createdAt: true, payoutAddress: true, payoutTag: true },
  });
}

// ── Payout rules (owner decision 2026-10-16) ───────────────────────────────────────────────────────────────────
// Grants are paid in RLUSD, from the pool's RLUSD only. The pool's XRP is never spent or converted without the
// owner's say-so; XRP is paid only to someone who can't hold RLUSD. Before paying anyone, check they can receive
// RLUSD (a trust line to Ripple's issuer with room for the amount and not frozen). Milestones count RLUSD at the
// current XRP price. If a milestone is reached but the RLUSD can't cover its grants, ONE healthchecks.io /fail asks
// the owner before any XRP is converted (checkpoint `grants-milestone-short:<xrp milestone>`).
export interface RlusdReceive { canReceive: boolean; reason: string }

export async function rlusdReceiveStatus(address: string, amount = 0): Promise<RlusdReceive> {
  const r = await rpc("account_lines", { account: address, peer: RLUSD_ISSUER, ledger_index: "validated" });
  if (!r) return { canReceive: false, reason: "couldn't read the ledger" };
  if (r.error === "actNotFound") return { canReceive: false, reason: "the account doesn't exist on the XRP Ledger" };
  const line = ((r.lines as { currency: string; balance: string; limit: string; freeze?: boolean; freeze_peer?: boolean }[] | undefined) ?? []).find((l) => l.currency === RLUSD_HEX);
  if (!line) return { canReceive: false, reason: "no RLUSD trust line" };
  if (line.freeze || line.freeze_peer) return { canReceive: false, reason: "their RLUSD trust line is frozen" };
  if (Number(line.limit) - Number(line.balance) < amount) return { canReceive: false, reason: "their RLUSD trust line limit is too low for this amount" };
  return { canReceive: true, reason: "has an RLUSD trust line" };
}

export const RLUSD_TRUSTLINE_MESSAGE = (amountUsd: number) =>
  `Hi — this is XRPLHub. Your community grant of $${amountUsd} is ready to send. We pay grants in RLUSD (a US-dollar stablecoin issued by Ripple), so your wallet needs an RLUSD trust line first. In Xaman: open your wallet, tap "+ Add asset" (or Assets → Add), search for RLUSD by Ripple (issuer rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De) and add it. It needs 0.2 XRP held in reserve, which you get back if you remove it later. Reply once it's added and we'll send the grant. We will never ask for your secret key or any payment.`;

/** Pool total valued in XRP and USD: XRP + RLUSD at the current XRP price. */
export function poolTotals(p: PoolState, xrpUsdPrice: number | null) {
  const xrp = p.balanceXrp ?? 0;
  const rlusd = p.rlusd.balance;
  if (!xrpUsdPrice) return { xrpEquivalent: xrp, usd: null as number | null, rlusd, xrp };
  return { xrpEquivalent: xrp + rlusd / xrpUsdPrice, usd: xrp * xrpUsdPrice + rlusd, rlusd, xrp };
}

/** Milestone reached but RLUSD short of what its grants need → ask the owner (once per milestone). */
export async function maybeMilestoneShortAlert(prisma: PrismaClient, ping: typeof pingHealthcheck = pingHealthcheck): Promise<boolean> {
  const [p, price] = await Promise.all([readPool(), xrpUsd().catch(() => null)]);
  const t = poolTotals(p, price);
  if (t.xrpEquivalent < FIRST_MILESTONE_XRP) return false;
  const first = await paidFirstGrants(prisma);
  const queue = await prisma.grantRequest.findMany({ where: { round: "pool-2026", status: { in: ["PENDING", "REVIEWING", "APPROVED"] } }, orderBy: { createdAt: "asc" }, take: FIRST_MILESTONE_GRANTS, select: { amountRequested: true } });
  const needUsd = first.reduce((s, g) => s + (g.approvedAmount ?? 0), 0) + queue.reduce((s, g) => s + g.amountRequested, 0);
  if (t.rlusd >= needUsd) return false;
  const id = `grants-milestone-short:${FIRST_MILESTONE_XRP}`;
  if (await prisma.indexerCheckpoint.findUnique({ where: { id } })) return false;
  await prisma.indexerCheckpoint.create({ data: { id, status: "idle", lastCompletedPassAt: new Date() } });
  await ping("/fail", `XRPLHub grants pool reached its ${FIRST_MILESTONE_XRP.toLocaleString("en-US")} XRP milestone (${Math.round(t.xrpEquivalent).toLocaleString("en-US")} XRP counting RLUSD), but it holds ${t.rlusd.toFixed(2)} RLUSD and the first grants need about $${needUsd.toFixed(2)}. Grants are paid in RLUSD only: decide whether to convert some of the pool's ${Math.round(t.xrp).toLocaleString("en-US")} XRP. Nothing has been converted.`);
  return true;
}

/** Can a grant be paid to this target now? RLUSD must be receivable, plus a destination tag if the account requires one. */
export async function payoutReadiness(address: string, tag: number | null | undefined, amount: number): Promise<{ ready: boolean; reason: string }> {
  const info = await rpc("account_info", { account: address, ledger_index: "validated" });
  const flags = Number((info?.account_data as { Flags?: number } | undefined)?.Flags ?? 0);
  if (flags & 0x20000 && tag == null) return { ready: false, reason: "needs payout details: this address requires a destination tag (it looks like an exchange account)" };
  const r = await rlusdReceiveStatus(address, amount);
  if (!r.canReceive) return { ready: false, reason: `needs payout details: ${r.reason}` };
  return { ready: true, reason: "ready to pay in RLUSD" };
}

/** Where a grant is paid: the accepted payout address/tag, else the applicant's wallet. */
export const payoutTarget = (g: { walletAddress: string; payoutAddress?: string | null; payoutTag?: number | null }) => ({ address: g.payoutAddress ?? g.walletAddress, tag: g.payoutTag ?? null });

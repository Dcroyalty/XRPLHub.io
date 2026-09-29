// src/lib/purchaseIntent.ts
// Storefront auto-detection: DISCOVERS a txHash for a manual payment (sent to the treasury with the
// right destination tag, from any wallet, never through Xaman or an injected wallet) so the customer
// doesn't have to paste one. Purely additive on top of paymentGate.ts -- this module never verifies a
// payment, prices it, or entitles anything itself; it only finds a candidate hash and hands it to the
// EXISTING verifyPayment()/registerPayment() (paymentGate.ts, untouched) exactly like the paste-a-hash
// path already does. Mirrors src/lib/rlusd.ts's findPayment() walk, simplified: this only needs to
// locate ANY validated Payment to the treasury carrying an exact DestinationTag -- amount/currency
// correctness is paymentGate.ts's job, not this module's.

import type { PrismaClient } from "@prisma/client";
import { xrplRpc } from "./xrplNodes";
import { TREASURY } from "./pricing";
import { verifyPayment, registerPayment } from "./paymentGate";
import { prismaPurchaseStore } from "./paymentStore";

const SCAN_PAGE_LIMIT = 100;
const SCAN_MAX_PAGES = 10; // bounded, like findPayment -- a runaway scan fails closed, never hangs
const TIME_SLACK_MS = 5 * 60_000;
export const INTENT_EXPIRE_MS = 30 * 60_000; // matches the Xaman payload expiry elsewhere on the storefront
const MAX_TAG = 2_147_483_647; // Postgres Int / XRPL DestinationTag, both 32-bit

/** A fresh, unused 1..2^31-1 destination tag. Retries a few times on the (astronomically unlikely) collision. */
export async function allocateDestinationTag(prisma: PrismaClient, productId: string): Promise<{ id: string; destinationTag: number; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + INTENT_EXPIRE_MS);
  for (let i = 0; i < 5; i++) {
    const destinationTag = 1 + Math.floor(Math.random() * (MAX_TAG - 1));
    try {
      const row = await prisma.purchaseIntent.create({ data: { productId, destinationTag, expiresAt } });
      return { id: row.id, destinationTag, expiresAt };
    } catch {
      /* unique collision -- retry */
    }
  }
  throw new Error("Could not allocate a destination tag after 5 attempts.");
}

function closeTimeMs(entry: Record<string, unknown> | undefined, tx: Record<string, unknown> | undefined): number | null {
  const raw = (entry?.close_time_iso as string | undefined) ?? null;
  if (raw) { const t = Date.parse(raw); if (Number.isFinite(t)) return t; }
  const rippleEpoch = tx?.date as number | undefined;
  if (typeof rippleEpoch === "number") return (rippleEpoch + 946_684_800) * 1000; // ripple epoch -> unix ms
  return null;
}

/**
 * Walk the treasury's account_tx backward, bounded by the intent's time window, looking for ANY
 * validated Payment to the treasury with `destinationTag`. Returns the hash if found. Does NOT check
 * amount, currency, or anything else -- that's verifyPayment's job once we hand it the hash.
 */
export async function findPaymentByTag(destinationTag: number, since: Date, until: Date): Promise<string | null> {
  const sinceMs = since.getTime() - TIME_SLACK_MS;
  const untilMs = until.getTime() + TIME_SLACK_MS;

  let marker: unknown = undefined;
  for (let page = 0; page < SCAN_MAX_PAGES; page++) {
    const r = await xrplRpc("account_tx", {
      account: TREASURY,
      ledger_index_min: -1,
      ledger_index_max: -1,
      binary: false,
      limit: SCAN_PAGE_LIMIT,
      forward: false,
      ...(marker ? { marker } : {}),
    });
    if (!r.ok) return null;
    const result = (r.body.result ?? {}) as { transactions?: Array<Record<string, unknown>>; marker?: unknown; error?: string };
    if (result.error) return null;

    for (const entry of result.transactions ?? []) {
      const tx = (entry.tx ?? entry.tx_json) as Record<string, unknown> | undefined;
      if (!tx) continue;
      if (entry.validated === false) continue;
      const t = closeTimeMs(entry, tx);
      if (t !== null && t < sinceMs) return null; // walked past the intent's creation -- not here
      if (t !== null && t > untilMs) continue; // newer than the window: keep walking back
      if (tx.TransactionType !== "Payment") continue;
      if (tx.Destination !== TREASURY) continue;
      if (tx.DestinationTag !== destinationTag) continue;
      const hash = (tx.hash as string | undefined) ?? (entry.hash as string | undefined);
      if (hash) return hash;
    }
    marker = result.marker;
    if (!marker) return null;
  }
  return null; // more traffic than the scan bound inside the window -- give up this round, try again next poll
}

export interface IntentCheckResult {
  status: "pending" | "verified" | "rejected" | "expired";
  txHash?: string;
  payer?: string;
  currency?: string;
  amount?: number;
  reason?: string;
}

/**
 * Check one intent: if not already matched, search for it; if found, run it through the REAL,
 * unmodified verifyPayment()/registerPayment(). Safe to call repeatedly (client poll or a cron sweep) --
 * idempotent, and never re-scans an intent that already has a matchedTxHash.
 */
export async function checkPurchaseIntent(prisma: PrismaClient, intentId: string): Promise<IntentCheckResult> {
  const intent = await prisma.purchaseIntent.findUnique({ where: { id: intentId } });
  if (!intent) return { status: "expired", reason: "No such intent." };

  let txHash = intent.matchedTxHash;
  if (!txHash) {
    if (Date.now() > intent.expiresAt.getTime() + TIME_SLACK_MS) return { status: "expired" };
    txHash = await findPaymentByTag(intent.destinationTag, intent.createdAt, intent.expiresAt);
    if (!txHash) return { status: "pending" };
    await prisma.purchaseIntent.update({ where: { id: intent.id }, data: { matchedTxHash: txHash, matchedAt: new Date() } });
  }

  const v = await verifyPayment(txHash, intent.productId);
  if (!v.ok) {
    await prisma.purchaseIntent.update({ where: { id: intent.id }, data: { note: `${v.code}: ${v.reason}`.slice(0, 500) } }).catch(() => {});
    if (v.retry) return { status: "pending" }; // ledger hasn't caught up yet -- not a real rejection
    return { status: "rejected", reason: v.reason };
  }

  const reg = await registerPayment(prismaPurchaseStore(), { payTxHash: v.txHash, productId: intent.productId, payer: v.payer, currency: v.currency, amount: v.amount });
  if (!reg.ok) {
    if (reg.retry) return { status: "pending" };
    return { status: "rejected", reason: reg.reason };
  }
  return { status: "verified", txHash: v.txHash, payer: v.payer, currency: v.currency, amount: v.amount };
}

/**
 * Cron-driven sweep: catches a payment even if the customer never reopens the tab. Bounded per run
 * (deadlineMs) like every other cron step in this app. Only looks at intents that aren't matched yet and
 * haven't expired -- a matched or expired intent is never re-scanned.
 */
export async function sweepPurchaseIntents(prisma: PrismaClient, opts: { deadlineMs?: number } = {}): Promise<{ checked: number; matched: number }> {
  const deadline = opts.deadlineMs ?? Date.now() + 20_000;
  const open = await prisma.purchaseIntent.findMany({
    where: { matchedTxHash: null, expiresAt: { gt: new Date(Date.now() - TIME_SLACK_MS) } },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  let checked = 0, matched = 0;
  for (const intent of open) {
    if (Date.now() > deadline) break;
    checked++;
    const r = await checkPurchaseIntent(prisma, intent.id);
    if (r.status === "verified") matched++;
  }
  return { checked, matched };
}

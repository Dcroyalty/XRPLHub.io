// lib/rlusd.ts
// RLUSD constants + payment verification for the XRPLScore checkout.
//
// TWO THINGS IN HERE ARE NON-NEGOTIABLE — they are what the dead-chat
// version got wrong, and they are the difference between "works" and
// "exchange gets drained":
//
//   1. The currency code is the 40-char HEX, never the string "RLUSD".
//      "RLUSD" is 5 characters; the XRPL standard code slot is 3 chars.
//      Anything longer MUST be a 160-bit (40 hex char) code. Passing
//      "RLUSD" to xrpl.js fails or mis-serializes.
//
//   2. Incoming payments are read from meta.delivered_amount, NEVER
//      from tx.Amount (a.k.a. DeliverMax in API v2). With the partial-
//      payment flag set, Amount can claim $2,000 while a fraction of a
//      cent actually lands. Reading the wrong field is the documented
//      way XRPL exchanges have been drained.
//
// Verified against XRPL.org + Ripple docs, Aug 2026.

import type { TransactionMetadata } from "xrpl";
import { xrplRpc } from "./xrplNodes";

// Ripple's official RLUSD MAINNET issuer. (Testnet is a different address.)
export const RLUSD_ISSUER =
  process.env.RLUSD_ISSUER ?? "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";

// ASCII "RLUSD" = 52 4C 55 53 44, right-padded with zeros to 40 hex chars.
// Padding is on the RIGHT. Reversing this makes a different, wrong token.
export const RLUSD_CURRENCY_HEX =
  "524C555344000000000000000000000000000000";

/**
 * Decode an XRPL currency code to its ASCII form. rippled returns 3-char ISO
 * codes verbatim and everything else as a 40-char hex string; xrpl.js does NOT
 * normalise this for you. "524C5553440000…" -> "RLUSD". Anything that is not a
 * 40-char hex string is returned unchanged.
 */
export function decodeCurrency(code: string | undefined | null): string {
  if (!code) return "";
  if (!/^[0-9A-Fa-f]{40}$/.test(code)) return code;
  const trimmed = code.replace(/(00)+$/i, "");
  let out = "";
  for (let i = 0; i + 1 < trimmed.length; i += 2) {
    out += String.fromCharCode(parseInt(trimmed.slice(i, i + 2), 16));
  }
  return out || code;
}

/**
 * True if a currency code from account_lines / delivered_amount is RLUSD,
 * whether the ledger handed it back as the 40-char hex or (rarely) "RLUSD".
 * Use this instead of `code === "RLUSD"` — that comparison is always false
 * because RLUSD is 5 chars and comes back hex-encoded.
 */
export function isRlusdCurrency(code: string | undefined | null): boolean {
  if (!code) return false;
  if (code.toUpperCase() === RLUSD_CURRENCY_HEX) return true;
  return decodeCurrency(code).toUpperCase() === "RLUSD";
}

// Your treasury wallet (the one already holding RLUSD). NOT the issuer.
export const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS ?? "";

/**
 * Pull the RLUSD amount that ACTUALLY arrived out of transaction metadata.
 * Returns the delivered RLUSD value as a number, or null if this tx did
 * not deliver RLUSD (wrong currency, XRP, pre-2014 "unavailable", etc.).
 *
 * This is the exploit guard. Do not "simplify" it to read tx.Amount.
 */
export function deliveredRlusd(meta: TransactionMetadata | undefined): number | null {
  const d = (meta as unknown as { delivered_amount?: unknown })?.delivered_amount;

  // Pre-2014 validated ledgers can report the string "unavailable".
  if (d === undefined || d === null || d === "unavailable") return null;

  // A bare string here means XRP (drops), not an issued token — reject.
  if (typeof d === "string") return null;

  const amt = d as { currency?: string; issuer?: string; value?: string };

  // Match issuer + the 40-char hex. Some tools decode the hex to "RLUSD";
  // accept either form defensively, but the ledger returns the hex.
  const currencyOk =
    amt.currency === RLUSD_CURRENCY_HEX || amt.currency === "RLUSD";
  const issuerOk = amt.issuer === RLUSD_ISSUER;

  if (currencyOk && issuerOk && amt.value) {
    const v = parseFloat(amt.value);
    return Number.isFinite(v) ? v : null;
  }
  return null;
}

/**
 * Pull the XRP amount (in drops) that ACTUALLY arrived. delivered_amount is a
 * bare string for XRP. Returns drops as a number, or null if this tx delivered
 * an issued token (not XRP) or nothing.
 */
export function deliveredXrpDrops(meta: TransactionMetadata | undefined): number | null {
  const d = (meta as unknown as { delivered_amount?: unknown })?.delivered_amount;
  if (d === undefined || d === null || d === "unavailable") return null;
  if (typeof d !== "string") return null; // issued currency object -> not XRP
  const drops = Number(d);
  return Number.isFinite(drops) && drops >= 0 ? drops : null;
}

export type PayCurrency = "RLUSD" | "XRP";

export interface PaymentMatch {
  paid: boolean;
  txHash?: string;
  deliveredRlusd?: number;
  deliveredXrp?: number;
  destinationTag?: number;
  /**
   * true  = the ledger was read completely for the requested window, so paid:false is a real "no payment".
   * false = the read was incomplete (nodes unreachable, or more traffic than the scan limit inside the window),
   *         so paid:false means "could not tell" and MUST NOT be turned into an expiry or a refusal.
   */
  complete: boolean;
}

const RIPPLE_EPOCH_MS = 946_684_800_000;
const SCAN_PAGE_LIMIT = 400;
/** Pages walked per lookup. The walk stops at the invoice's creation time, so this bounds only pathological spam. */
const SCAN_MAX_PAGES = 8;
/** Ledger close times and our clock can differ a little; never reject a payment for that. */
const TIME_SLACK_MS = 60_000;

/** When a transaction's ledger closed, in epoch ms. account_tx (API v2) gives close_time_iso; v1 gives tx.date. */
function closeTimeMs(entry: Record<string, unknown> | undefined, tx: Record<string, unknown> | undefined): number | null {
  const iso = entry?.close_time_iso;
  if (typeof iso === "string") {
    const t = Date.parse(iso);
    if (Number.isFinite(t)) return t;
  }
  const d = tx?.date ?? entry?.date;
  return typeof d === "number" ? d * 1000 + RIPPLE_EPOCH_MS : null;
}

interface WantedPayment {
  treasury: string;
  destinationTag: number;
  expected: number;
  currency: PayCurrency;
}

/**
 * The ONE check that decides whether a ledger transaction settles an invoice. Pure. A transaction counts only if it
 * is a successful Payment to the treasury carrying the invoice's destination tag, and what ARRIVED (delivered_amount,
 * never tx.Amount) covers the quoted amount in the quoted currency.
 */
export function paymentSettlesInvoice(
  tx: Record<string, unknown> | undefined,
  meta: TransactionMetadata | undefined,
  want: WantedPayment,
): PaymentMatch | null {
  if (!tx || !meta) return null;
  if (tx.TransactionType !== "Payment") return null;
  if (tx.Destination !== want.treasury) return null;
  if (tx.Account === want.treasury) return null;
  if (Number(tx.DestinationTag) !== want.destinationTag) return null;
  const code = (meta as unknown as { TransactionResult?: string }).TransactionResult;
  if (code !== "tesSUCCESS") return null;
  const txHash = String(tx.hash ?? "");

  if (want.currency === "XRP") {
    const drops = deliveredXrpDrops(meta);
    if (drops === null) return null;
    const xrp = drops / 1_000_000;
    if (xrp + 1e-6 < want.expected) return null;
    return { paid: true, txHash, deliveredXrp: xrp, destinationTag: want.destinationTag, complete: true };
  }
  const delivered = deliveredRlusd(meta);
  if (delivered === null || delivered + 1e-6 < want.expected) return null;
  return { paid: true, txHash, deliveredRlusd: delivered, destinationTag: want.destinationTag, complete: true };
}

/**
 * Find the settled payment for an invoice. Two ways, no fixed-size window:
 *
 *  - BY HASH (opts.txHash): one exact `tx` lookup, then the same checks as below. Used when the payer's wallet or the
 *    Xaman payload already told us the hash.
 *  - BY TAG: the XRPL cannot filter account_tx by destination tag, so walk the treasury's history newest-first,
 *    page by page, until reaching a transaction older than the invoice's creation. Every transaction inside the
 *    invoice's lifetime is examined however much dust arrived meanwhile — dust can no longer push a real payment
 *    out of view. If the walk cannot finish (nodes down, or more traffic than SCAN_MAX_PAGES pages) the result says
 *    complete:false rather than claiming nothing was paid.
 *
 * Only payments that closed within [since, until] count: not before the invoice existed, and not after it expired
 * (the XRP amount was quoted at a rate that is only honoured for the invoice's lifetime).
 */
export async function findPayment(
  destinationTag: number,
  expected: number,
  opts: { currency?: PayCurrency; treasury?: string; since?: Date; until?: Date; txHash?: string } = {}
): Promise<PaymentMatch> {
  const treasury = opts.treasury ?? TREASURY_ADDRESS;
  if (!treasury) throw new Error("TREASURY_ADDRESS is not set");
  const want: WantedPayment = { treasury, destinationTag, expected, currency: opts.currency ?? "RLUSD" };
  const sinceMs = opts.since ? opts.since.getTime() - TIME_SLACK_MS : null;
  const untilMs = opts.until ? opts.until.getTime() + TIME_SLACK_MS : null;
  const inWindow = (t: number | null) => t === null || ((sinceMs === null || t >= sinceMs) && (untilMs === null || t <= untilMs));

  // ── by hash ──
  if (opts.txHash) {
    if (!/^[0-9A-Fa-f]{64}$/.test(opts.txHash)) return { paid: false, complete: true };
    const r = await xrplRpc("tx", { transaction: opts.txHash, binary: false });
    if (!r.ok) return { paid: false, complete: false };
    const res = (r.body.result ?? {}) as Record<string, unknown>;
    if (res.error) return { paid: false, complete: res.error === "txnNotFound" ? false : true }; // not visible yet != not paid
    if (res.validated !== true) return { paid: false, complete: false };
    if (!inWindow(closeTimeMs(undefined, res))) return { paid: false, complete: true };
    const hit = paymentSettlesInvoice(res, (res.meta ?? res.metaData) as TransactionMetadata | undefined, want);
    return hit ?? { paid: false, complete: true };
  }

  // ── by tag: bounded by TIME, not by count ──
  let marker: unknown = undefined;
  for (let page = 0; page < SCAN_MAX_PAGES; page++) {
    const r = await xrplRpc("account_tx", {
      account: treasury,
      ledger_index_min: -1,
      ledger_index_max: -1,
      binary: false,
      limit: SCAN_PAGE_LIMIT,
      forward: false,
      ...(marker ? { marker } : {}),
    });
    if (!r.ok) return { paid: false, complete: false };
    const result = (r.body.result ?? {}) as { transactions?: Array<Record<string, unknown>>; marker?: unknown; error?: string };
    if (result.error) return { paid: false, complete: false };

    for (const entry of result.transactions ?? []) {
      // xrpl.js / rippled have shifted shapes across versions: tx | tx_json, meta | metaData. Read all of them.
      const tx = (entry.tx ?? entry.tx_json) as Record<string, unknown> | undefined;
      const meta = (entry.meta ?? entry.metaData) as TransactionMetadata | undefined;
      if (!tx) continue;
      if (entry.validated === false) continue;
      if (tx.hash === undefined && typeof entry.hash === "string") tx.hash = entry.hash;
      const t = closeTimeMs(entry, tx);
      if (t !== null && sinceMs !== null && t < sinceMs) return { paid: false, complete: true }; // walked past the invoice's creation
      if (!inWindow(t)) continue; // newer than the expiry: not eligible, keep walking back
      const hit = paymentSettlesInvoice(tx, meta, want);
      if (hit) return hit;
    }
    marker = result.marker;
    if (!marker) return { paid: false, complete: true }; // reached the start of the account's history
  }
  return { paid: false, complete: false }; // more traffic than the scan limit inside the window
}

const TAG_WARNING =
  "Destination tag is REQUIRED. A payment without this exact tag cannot be matched to your order.";

/**
 * Fields a human needs to pay an invoice by hand (exchange withdrawal, or a
 * wallet without a deeplink). This is the "manual-pay panel" data.
 */
export function manualPayFields(amountRlusd: number, destinationTag: number) {
  return {
    address: TREASURY_ADDRESS,
    destinationTag,
    amount: amountRlusd.toFixed(6),
    currency: "RLUSD",
    currencyHex: RLUSD_CURRENCY_HEX,
    issuer: RLUSD_ISSUER,
    warning: TAG_WARNING,
  };
}

/** Manual-pay panel data for an XRP invoice (no issuer / currency code). */
export function manualPayFieldsXrp(amountXrp: number, destinationTag: number) {
  return {
    address: TREASURY_ADDRESS,
    destinationTag,
    amount: amountXrp.toFixed(6),
    currency: "XRP",
    warning: TAG_WARNING,
  };
}

/** xumm:// deeplink for either currency. */
export function xamanDeeplink(
  currency: "RLUSD" | "XRP",
  amount: number,
  destinationTag: number
): string {
  const params = new URLSearchParams({
    to: TREASURY_ADDRESS,
    amount: amount.toFixed(6),
    dt: String(destinationTag),
  });
  if (currency === "RLUSD") {
    params.set("currency", RLUSD_CURRENCY_HEX);
    params.set("issuer", RLUSD_ISSUER);
  }
  return `https://xumm.app/detect/request?${params.toString()}`;
}

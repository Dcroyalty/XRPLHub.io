// src/lib/checks.ts
// XRPL Checks (CheckCreate / CheckCash / CheckCancel) in XRP or RLUSD — the ONE builder the storefront services
// (checkcreate / checkcash / checkcancel) and Spend Controls (src/lib/spendControls.ts) both use.
//
// Ledger behaviour this rests on (verified on Testnet 2026-10-05 with a stand-in issuer carrying RLUSD's flags):
//   - A check is SINGLE-USE: cashing for less than SendMax consumes it; Amount above SendMax -> tecPATH_PARTIAL.
//   - DeliverMin cashes "as much as the sender has, at least this"; Amount cashes exactly that or fails.
//   - Checks do NOT lock funds. The recipient needs no RLUSD trust line beforehand (CheckCashMakesTrustLine); cashing
//     creates it and uses 0.2 XRP of THEIR reserve. Each open check holds 0.2 XRP of the SENDER's reserve until it is
//     cashed or cancelled. Only sender or recipient may cancel before Expiration; anyone may after.
//   - A CheckCreate whose Expiration has already passed fails tecEXPIRED (and still burns the fee).
//   - xrpl.js 4.6 validate() lets a CheckCash with a MISSING CheckID through — so CheckID is checked here.

import { validate } from "xrpl";
import { RLUSD_ISSUER, RLUSD_HEX } from "./pricing";

export type CheckCurrency = "XRP" | "RLUSD";
export const CHECK_ID_RE = /^[0-9A-F]{64}$/;
export const RIPPLE_EPOCH = 946_684_800;
/** Refuse an Expiration closer than this — the ledger would reject it (tecEXPIRED) after the fee is spent. */
export const MIN_EXPIRY_LEAD_S = 15 * 60;

type Built = { ok: true; txjson: Record<string, unknown> } | { ok: false; error: string };
const bad = (error: string): Built => ({ ok: false, error });

export function parseCurrency(raw: unknown): CheckCurrency | null {
  const c = String(raw ?? "XRP").trim().toUpperCase();
  return c === "XRP" || c === "" ? "XRP" : c === "RLUSD" ? "RLUSD" : null;
}

/** A positive plain decimal with at most 6 places (XRP drops) / 15 significant digits (RLUSD). */
export function checkAmount(currency: CheckCurrency, raw: unknown): { ok: true; amount: string | Record<string, string> } | { ok: false; error: string } {
  const v = String(raw ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(v) || Number(v) <= 0) return { ok: false, error: "the amount must be a positive number like 10 or 0.5" };
  if (currency === "XRP") {
    if ((v.split(".")[1] ?? "").length > 6) return { ok: false, error: "XRP amounts have at most 6 decimal places" };
    const drops = BigInt(v.split(".")[0]) * BigInt(1_000_000) + BigInt(((v.split(".")[1] ?? "") + "000000").slice(0, 6));
    return { ok: true, amount: drops.toString() };
  }
  if (v.replace(".", "").replace(/^0+/, "").length > 15) return { ok: false, error: "RLUSD amounts have at most 15 significant digits" };
  return { ok: true, amount: { currency: RLUSD_HEX, issuer: RLUSD_ISSUER, value: v } };
}

export function normalizeCheckId(raw: unknown): string | null {
  const id = String(raw ?? "").trim().toUpperCase();
  return CHECK_ID_RE.test(id) ? id : null;
}

function checked(txjson: Record<string, unknown>): Built {
  // Our own CheckID guard first — validate() does not catch a missing one.
  if ((txjson.TransactionType === "CheckCash" || txjson.TransactionType === "CheckCancel") && !CHECK_ID_RE.test(String(txjson.CheckID ?? ""))) {
    return bad("a check ID is 64 hexadecimal characters");
  }
  try {
    validate({ ...txjson, Fee: "12", Sequence: 1 } as Parameters<typeof validate>[0]);
    return { ok: true, txjson };
  } catch (e) {
    return bad(`the transaction failed validation: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface CheckCreateArgs {
  account: string;
  destination: string;
  currency: CheckCurrency;
  amount: unknown;
  /** Ripple-epoch seconds. */
  expiration?: number;
  destinationTag?: number;
  /** 64-hex. Spend Controls uses it to recognise its own checks on the ledger. */
  invoiceId?: string;
  /** For tests: "now" in Ripple-epoch seconds. */
  nowRipple?: number;
}

export function buildCheckCreate(a: CheckCreateArgs): Built {
  if (a.destination === a.account) return bad("you can't write a check to yourself");
  const amt = checkAmount(a.currency, a.amount);
  if (!amt.ok) return bad(amt.error);
  const tx: Record<string, unknown> = { TransactionType: "CheckCreate", Account: a.account, Destination: a.destination, SendMax: amt.amount };
  if (a.expiration !== undefined) {
    const now = a.nowRipple ?? Math.floor(Date.now() / 1000) - RIPPLE_EPOCH;
    if (!Number.isInteger(a.expiration) || a.expiration < now + MIN_EXPIRY_LEAD_S) return bad("the expiry must be at least 15 minutes in the future");
    tx.Expiration = a.expiration;
  }
  if (a.destinationTag !== undefined) {
    if (!Number.isInteger(a.destinationTag) || a.destinationTag < 0 || a.destinationTag > 4_294_967_295) return bad("a destination tag is a whole number 0–4294967295");
    tx.DestinationTag = a.destinationTag;
  }
  if (a.invoiceId !== undefined) {
    if (!CHECK_ID_RE.test(a.invoiceId)) return bad("invoice id must be 64 hex characters");
    tx.InvoiceID = a.invoiceId;
  }
  return checked(tx);
}

/** mode "exact" = Amount (that much or nothing); "atLeast" = DeliverMin (as much as available, at least that much). */
export function buildCheckCash(a: { account: string; checkId: unknown; currency: CheckCurrency; amount: unknown; mode?: "exact" | "atLeast" }): Built {
  const id = normalizeCheckId(a.checkId);
  if (!id) return bad("a check ID is 64 hexadecimal characters");
  const amt = checkAmount(a.currency, a.amount);
  if (!amt.ok) return bad(amt.error);
  return checked({ TransactionType: "CheckCash", Account: a.account, CheckID: id, ...(a.mode === "atLeast" ? { DeliverMin: amt.amount } : { Amount: amt.amount }) });
}

export function buildCheckCancel(a: { account: string; checkId: unknown }): Built {
  const id = normalizeCheckId(a.checkId);
  if (!id) return bad("a check ID is 64 hexadecimal characters");
  return checked({ TransactionType: "CheckCancel", Account: a.account, CheckID: id });
}

// src/lib/paymentGate.ts
// The storefront payment gate. Two jobs:
//
//  1. VERIFY a payment on the ledger against the SERVER's price table (pricing.ts):
//     validated ledger, tesSUCCESS, a Payment to the treasury, not a partial payment,
//     the right currency (XRP, or RLUSD from the real RLUSD issuer — not a look-alike
//     token), and an amount that covers the product. Nothing the client says about
//     amount, currency or price is read.
//
//  2. ENTITLE exactly one delivery per payment hash, enforced in the database. The
//     payment hash is Purchase.txHash (UNIQUE). A row moves through:
//        VERIFIED                         paid, nothing issued yet
//        ACTIVE|<issued>|<plan>           build payloads issued (capped), plan fixed at step 1
//        DELIVERED                        every step of the plan confirmed on-ledger
//     Every transition is a compare-and-set, so concurrent requests can't both win.
//     A row is bound to the FIRST product it is used for and to its payer; using the
//     hash for another product or account is rejected, and so is reusing it after delivery.
//
// Pure logic against a PurchaseStore interface (paymentStore.ts is the Prisma adapter),
// so it can be tested without a database.

import { xrplRpc } from "./xrplNodes";
import {
  OPEN_AMOUNT_PRODUCTS,
  RLUSD_HEX,
  RLUSD_ISSUER,
  TREASURY,
  currentXrpUsd,
  isPaymentSufficient,
  priceUsd,
  type PayCurrency,
} from "./pricing";

const TF_PARTIAL_PAYMENT = 0x00020000;
const HASH_RE = /^[0-9A-Fa-f]{64}$/;
/** Payload issuances allowed per step before a payment stops issuing (covers expired/declined retries). */
export const ISSUES_PER_STEP = 3;

export type GateCode =
  | "bad_hash" | "not_found" | "not_validated" | "failed" | "not_payment" | "wrong_destination"
  | "partial_payment" | "bad_currency" | "underpaid" | "unknown_product" | "xrp_price_unavailable"
  | "sender_mismatch" | "bound_to_other_product" | "already_used" | "wrong_step" | "issue_limit"
  | "conflict" | "no_payment_record" | "bad_plan" | "bad_service_tx" | "ledger_unavailable";

export interface GateFailure {
  ok: false;
  code: GateCode;
  reason: string;
  /** true = the caller should simply poll again (ledger hasn't caught up / transient). */
  retry?: boolean;
}
const fail = (code: GateCode, reason: string, retry = false): GateFailure => ({ ok: false, code, reason, ...(retry ? { retry: true } : {}) });

// ── 1. Ledger verification ───────────────────────────────────────────────────

export type LedgerTx = Record<string, unknown>;

export async function fetchLedgerTx(txHash: string): Promise<{ ok: true; tx: LedgerTx } | GateFailure> {
  if (!HASH_RE.test(txHash)) return fail("bad_hash", "Bad transaction hash.");
  const r = await xrplRpc("tx", { transaction: txHash, binary: false });
  if (!r.ok) return fail("ledger_unavailable", "The XRP Ledger is temporarily unreachable — retry in a moment.", true);
  const result = r.body.result as LedgerTx | undefined;
  if (!result || result.error) return fail("not_found", "Transaction not yet visible on the ledger — retry in a moment.", true);
  return { ok: true, tx: result };
}

export interface InspectedPayment {
  ok: true;
  txHash: string;
  payer: string;
  currency: PayCurrency;
  /** What actually arrived at the treasury (delivered amount), as a number. */
  amount: number;
  ledgerIndex: number | null;
}

/** Everything about a payment that does NOT depend on price. Pure. */
export function inspectPayment(tx: LedgerTx): InspectedPayment | GateFailure {
  if (tx.validated !== true) return fail("not_validated", "Payment is not in a validated ledger yet — retry in a moment.", true);
  const meta = (tx.meta ?? tx.metaData) as Record<string, unknown> | undefined;
  if (meta?.TransactionResult !== "tesSUCCESS") return fail("failed", `Transaction failed on ledger: ${String(meta?.TransactionResult ?? "unknown")}`);
  if (tx.TransactionType !== "Payment") return fail("not_payment", "Not a payment transaction.");
  if (tx.Destination !== TREASURY) return fail("wrong_destination", "Payment was not sent to the XRPLHub treasury.");
  if (tx.Account === TREASURY) return fail("wrong_destination", "Payment from the treasury to itself does not count.");
  // A partial payment can deliver far less than its Amount field claims. We never ask for one.
  if ((Number(tx.Flags ?? 0) & TF_PARTIAL_PAYMENT) !== 0) return fail("partial_payment", "Partial payments are not accepted.");

  const delivered = meta?.delivered_amount ?? meta?.DeliveredAmount;
  const amt = delivered && delivered !== "unavailable" ? delivered : tx.Amount;
  let currency: PayCurrency;
  let value: number;
  if (typeof amt === "string") {
    currency = "XRP";
    value = Number(amt) / 1e6;
  } else if (amt && typeof amt === "object") {
    const a = amt as { currency?: string; issuer?: string; value?: string };
    if (String(a.currency ?? "").toUpperCase() !== RLUSD_HEX || a.issuer !== RLUSD_ISSUER)
      return fail("bad_currency", "Only XRP or RLUSD (from the official RLUSD issuer) is accepted.");
    currency = "RLUSD";
    value = Number(a.value);
  } else {
    return fail("bad_currency", "Could not read the payment amount.");
  }
  if (!Number.isFinite(value) || value <= 0) return fail("underpaid", "Payment amount is zero.");
  const li = tx.ledger_index;
  return { ok: true, txHash: String(tx.hash ?? ""), payer: String(tx.Account), currency, amount: value, ledgerIndex: typeof li === "number" ? li : null };
}

/** Is an inspected payment enough for `productId`? Pure given the current XRP/USD rate. */
export function checkAmountForProduct(p: InspectedPayment, productId: string, rate: number | null): InspectedPayment | GateFailure {
  if (OPEN_AMOUNT_PRODUCTS.has(productId)) return p; // donations: any positive amount, real currency
  const usd = priceUsd(productId);
  if (usd == null) return fail("unknown_product", `Unknown product "${productId}".`);
  if (!isPaymentSufficient(usd, p.currency, p.amount, rate))
    return fail("underpaid", `Amount too low: received ${p.amount} ${p.currency}, the price is $${usd} (${p.currency === "RLUSD" ? `${usd} RLUSD` : "its XRP equivalent"}).`);
  return p;
}

/** Fetch + inspect + price-check a payment. Never reads anything from the client except the hash and product id. */
export async function verifyPayment(txHash: string, productId: string): Promise<InspectedPayment | GateFailure> {
  const got = await fetchLedgerTx(txHash);
  if (!got.ok) return got;
  const inspected = inspectPayment(got.tx);
  if (!inspected.ok) return inspected;
  let rate: number | null = null;
  if (inspected.currency === "XRP" && !OPEN_AMOUNT_PRODUCTS.has(productId) && priceUsd(productId) != null) {
    try {
      rate = await currentXrpUsd();
    } catch {
      return fail("xrp_price_unavailable", "XRP pricing is temporarily unavailable — retry in a moment.", true);
    }
  }
  return checkAmountForProduct({ ...inspected, txHash: inspected.txHash || txHash }, productId, rate);
}

// ── 2. Entitlement (database) ────────────────────────────────────────────────

export interface PlanStep {
  /** stable step id, e.g. "signerlist" — the plan is fixed at step 1 and later steps are built BY ID */
  id: string;
  /** the XRPL TransactionType this step must be, checked when delivery is confirmed */
  type: string;
}

export interface PurchaseRow {
  id: string;
  productId: string;
  wallet: string | null;
  status: string;
  serviceTxHash: string | null;
}

export interface PurchaseStore {
  find(txHash: string): Promise<PurchaseRow | null>;
  /** returns "exists" if the UNIQUE txHash already has a row (lost a race) */
  create(row: { productId: string; wallet: string; currency: string; amount: string; txHash: string; status: string }): Promise<PurchaseRow | "exists">;
  /** atomic: set status = to WHERE id AND status = from. true if exactly one row changed */
  casStatus(id: string, from: string, to: string): Promise<boolean>;
  /** atomic: set serviceTxHash/status(/deliveredAt) WHERE id AND serviceTxHash = from */
  casProgress(id: string, fromServiceTxHash: string | null, to: { serviceTxHash: string; status: string; deliveredAt?: Date }): Promise<boolean>;
}

interface State {
  phase: "VERIFIED" | "ACTIVE" | "DELIVERED";
  issued: number;
  plan: PlanStep[];
}

export function parseStatus(status: string): State {
  if (status === "DELIVERED") return { phase: "DELIVERED", issued: 0, plan: [] };
  if (status.startsWith("ACTIVE|")) {
    const [, issued, plan] = status.split("|");
    return {
      phase: "ACTIVE",
      issued: Number(issued) || 0,
      plan: (plan ?? "").split(",").filter(Boolean).map((s) => {
        const [id, type] = s.split(":");
        return { id, type };
      }),
    };
  }
  return { phase: "VERIFIED", issued: 0, plan: [] };
}
export const formatActive = (issued: number, plan: PlanStep[]) => `ACTIVE|${issued}|${plan.map((s) => `${s.id}:${s.type}`).join(",")}`;
export const deliveredHashes = (row: PurchaseRow): string[] => (row.serviceTxHash ?? "").split(",").filter(Boolean);

export interface PaymentBinding {
  payTxHash: string;
  productId: string;
  payer: string;
  currency: PayCurrency;
  amount: number;
}

async function loadOrCreate(store: PurchaseStore, b: PaymentBinding): Promise<PurchaseRow | GateFailure> {
  let row = await store.find(b.payTxHash);
  if (!row) {
    const made = await store.create({ productId: b.productId, wallet: b.payer, currency: b.currency, amount: String(b.amount), txHash: b.payTxHash, status: "VERIFIED" });
    row = made === "exists" ? await store.find(b.payTxHash) : made;
    if (!row) return fail("conflict", "Could not record the payment — retry.", true);
  }
  if (row.productId !== b.productId)
    return fail("bound_to_other_product", "This payment was already used for a different service.");
  if (row.wallet && row.wallet !== b.payer) return fail("sender_mismatch", "Payment sender does not match the recorded payer.");
  return row;
}

/** Record a verified payment (check-payment). Idempotent; binds the hash to its first product. */
export async function registerPayment(store: PurchaseStore, b: PaymentBinding): Promise<{ ok: true; row: PurchaseRow } | GateFailure> {
  const row = await loadOrCreate(store, b);
  return "ok" in row ? row : { ok: true, row };
}

export interface ClaimArgs extends PaymentBinding {
  /** the wallet that will sign the service transaction — must be the payer */
  account: string;
  /** 1-based step being issued */
  step: number;
  /** the plan computed by the builder — only used to fix the plan at step 1 */
  plan?: PlanStep[];
}

export type ClaimResult = { ok: true; step: number; plan: PlanStep[] } | GateFailure;

/**
 * Authorise issuing ONE build payload for `step`. Exactly one caller wins each
 * transition; a payment can never issue more than ISSUES_PER_STEP payloads per step,
 * never for another product/account, and never after it is DELIVERED.
 */
export async function claimBuild(store: PurchaseStore, a: ClaimArgs): Promise<ClaimResult> {
  if (a.account !== a.payer) return fail("sender_mismatch", "The service must be built for the wallet that paid.");
  const loaded = await loadOrCreate(store, a);
  if ("ok" in loaded) return loaded;
  const row = loaded;

  const state = parseStatus(row.status);
  if (state.phase === "DELIVERED") return fail("already_used", "This payment has already been used to deliver its service.");

  const plan = state.phase === "ACTIVE" ? state.plan : a.plan ?? [];
  if (plan.length === 0) return fail("bad_plan", "No service plan available for this payment.");
  const delivered = deliveredHashes(row).length;
  if (a.step !== delivered + 1)
    return fail("wrong_step", a.step <= delivered ? `Step ${a.step} was already delivered.` : `Complete step ${delivered + 1} first.`);
  if (a.step > plan.length) return fail("wrong_step", "That step is beyond this service's plan.");
  if (state.issued >= ISSUES_PER_STEP * plan.length) return fail("issue_limit", "This payment has reached its limit of build attempts. Contact support@xrplhub.io.");

  const next = formatActive(state.issued + 1, plan);
  const won = await store.casStatus(row.id, row.status, next);
  if (!won) return fail("conflict", "Another request is already processing this payment — retry.", true);
  return { ok: true, step: a.step, plan };
}

export interface DeliveryArgs {
  payTxHash: string;
  serviceTxHash: string;
  /** the service transaction as returned by the `tx` RPC */
  serviceTx: LedgerTx;
  /** ledger the payment was validated in — the service tx must not be older */
  paymentLedgerIndex: number | null;
}

export type DeliveryResult =
  | { ok: true; step: number; totalSteps: number; done: boolean; productId: string; plan: PlanStep[]; nextStep: (PlanStep & { step: number }) | null }
  | GateFailure;

/**
 * Confirm one delivered step. The service tx must be validated, tesSUCCESS, signed by
 * the payer, of the type the plan expects for the next step, and not older than the
 * payment — so a payment cannot be marked delivered by an unrelated old transaction.
 * The product/plan come from the DATABASE row, never from the caller.
 */
export async function recordStepDelivered(store: PurchaseStore, d: DeliveryArgs): Promise<DeliveryResult> {
  const row = await store.find(d.payTxHash);
  if (!row) return fail("no_payment_record", "No verified payment is on record for that hash.");
  const state = parseStatus(row.status);
  const hashes = deliveredHashes(row);

  const done = (hs: string[], plan: PlanStep[]): DeliveryResult => ({
    ok: true, step: hs.length, totalSteps: plan.length, done: hs.length >= plan.length, productId: row.productId, plan,
    nextStep: hs.length < plan.length ? { step: hs.length + 1, ...plan[hs.length] } : null,
  });
  // idempotent: this exact service tx was already recorded
  if (hashes.includes(d.serviceTxHash)) return done(hashes, state.plan.length ? state.plan : hashes.map(() => ({ id: "", type: "" })));
  if (state.phase === "DELIVERED") return fail("already_used", "This payment has already been used to deliver its service.");
  if (state.phase !== "ACTIVE" || state.plan.length === 0) return fail("bad_plan", "No build was issued for this payment.");

  const tx = d.serviceTx;
  const meta = (tx.meta ?? tx.metaData) as Record<string, unknown> | undefined;
  if (tx.validated !== true) return fail("not_validated", "Service transaction is not validated yet.", true);
  if (meta?.TransactionResult !== "tesSUCCESS") return fail("bad_service_tx", `Service transaction failed on ledger: ${String(meta?.TransactionResult ?? "unknown")}`);
  if (tx.Account !== row.wallet) return fail("sender_mismatch", "The service transaction was not signed by the paying wallet.");
  const expected = state.plan[hashes.length];
  if (!expected || tx.TransactionType !== expected.type)
    return fail("bad_service_tx", `Expected a ${expected?.type ?? "?"} transaction for step ${hashes.length + 1}, got ${String(tx.TransactionType)}.`);
  const li = tx.ledger_index;
  if (d.paymentLedgerIndex != null && typeof li === "number" && li < d.paymentLedgerIndex)
    return fail("bad_service_tx", "The service transaction predates the payment.");

  const nextHashes = [...hashes, d.serviceTxHash];
  const complete = nextHashes.length >= state.plan.length;
  const won = await store.casProgress(row.id, row.serviceTxHash, {
    serviceTxHash: nextHashes.join(","),
    status: complete ? "DELIVERED" : row.status,
    ...(complete ? { deliveredAt: new Date() } : {}),
  });
  if (!won) {
    const again = await store.find(d.payTxHash);
    if (again && deliveredHashes(again).includes(d.serviceTxHash)) return done(deliveredHashes(again), state.plan);
    return fail("conflict", "Another request is recording this payment — retry.", true);
  }
  return done(nextHashes, state.plan);
}

// src/lib/autopay.ts
// Spend Controls AUTOPAY (2026-10-09) — the ledger core. Subscriptions only.
//
// How it works (owner spec 2026-10-07, unblocked by the Xaman probe on 2026-10-09):
//   1. The payer signs ONE TicketCreate for N tickets (Xaman submits it). Each ticket holds one owner reserve (0.2 XRP).
//   2. The payer pre-signs N Payments to the plan's one payee — one per future period — each with Sequence 0, its own
//      TicketSequence and a far-future LastLedgerSequence WE set. Xaman signs with submit:false and returns the blob.
//      PROBE RESULT (signed request 427afc24, 2026-10-09): Xaman kept our LastLedgerSequence (112542631) unchanged and
//      kept Sequence 0 + TicketSequence; without our own LastLedgerSequence it adds one ~1 minute ahead, so we ALWAYS set it.
//   3. We store each signed blob encrypted (AES-256-GCM, SPEND_AUTOPAY_KEY) and submit exactly one per period, at or
//      after that period's start — never early — and never after the period's end + grace.
//   4. Cancel = the payer consumes the remaining tickets (a no-op AccountSet per ticket, or one Batch once Batch is
//      verified in Xaman). A blob whose ticket is gone can never be applied (tefNO_TICKET), by anyone.
//   5. A payment that fails on the ledger (tec: e.g. not enough money) is NOT retried — the ticket is consumed and we
//      tell both sides. Only non-final answers (tel/ter, or not yet validated) are re-sent, with the same blob: it can
//      apply at most once because its ticket can only be used once.
//
// This file has NO local imports (only `xrpl` and `crypto`), so scripts/test-autopay-testnet.ts runs the exact same
// code against XRPL Testnet. Prisma glue lives in spendAutopay.ts.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { decode, hashes, verifySignature } from "xrpl";

/** A JSON-RPC call: the `result` object (which may carry `error`), or null when no node answered. */
export type Rpc = (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown> | null>;

export type AutopayPeriod = "weekly" | "monthly";
export type AutopayCurrency = "XRP" | "RLUSD";
export type RowStatus = "unsigned" | "scheduled" | "pending" | "paid" | "failed" | "missed" | "cancelled";

export const AUTOPAY_MAX_PERIODS = 12;
/** Network fee written into every pre-signed payment, in drops. Base fee is 10; the margin rides out mild load. */
export const AUTOPAY_FEE_DROPS = "20";
/** We refuse a signed blob whose fee was raised above this (a wallet may adjust fees; we never accept a big one). */
export const AUTOPAY_MAX_FEE_DROPS = 1000;
/** Submit window: from the period's start to its end plus this grace (same grace subscription checks get). */
export const AUTOPAY_GRACE_S = 3 * 86_400;
/** LastLedgerSequence is computed as if ledgers closed every 3 s (real: ~3.5–4 s), so it lands AFTER the deadline. */
export const FAST_LEDGER_S = 3;
const RIPPLE_EPOCH = 946_684_800;
const TF_FULLY_CANONICAL_SIG = 0x80000000;
const TF_INNER_BATCH_TXN = 0x40000000;
const LSF_REQUIRE_DEST_TAG = 0x00020000;
const LSF_DEPOSIT_AUTH = 0x01000000;

// ── periods (UTC; identical rules to spendControls.periodWindow) ───────────────────────────────────────────────────
export function periodStartOf(period: AutopayPeriod, now: Date): Date {
  if (period === "monthly") return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const day = (now.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day));
}
export function addPeriods(period: AutopayPeriod, start: Date, k: number): Date {
  return period === "monthly"
    ? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + k, 1))
    : new Date(start.getTime() + k * 7 * 86_400_000);
}
/** The next N periods, starting with the one AFTER the current period (the current one is paid by a normal check). */
export function autopayPeriods(period: AutopayPeriod, now: Date, n: number): { start: Date; end: Date }[] {
  const first = addPeriods(period, periodStartOf(period, now), 1);
  return Array.from({ length: n }, (_, k) => ({ start: addPeriods(period, first, k), end: addPeriods(period, first, k + 1) }));
}

/** A LastLedgerSequence that is still in the future at `deadline`, even if ledgers close faster than usual. */
export function lastLedgerFor(deadline: Date, ledger: { index: number; closeTimeMs: number }): number {
  const secs = Math.max(0, (deadline.getTime() - ledger.closeTimeMs) / 1000);
  const lls = ledger.index + Math.ceil(secs / FAST_LEDGER_S) + 100;
  if (lls > 0xffffffff) throw new Error("deadline too far ahead for a LastLedgerSequence");
  return lls;
}

export async function validatedLedger(rpc: Rpc): Promise<{ index: number; closeTimeMs: number } | null> {
  const r = await rpc("ledger", { ledger_index: "validated" });
  const l = r?.ledger as { ledger_index?: string | number; close_time?: number } | undefined;
  const index = Number(l?.ledger_index ?? r?.ledger_index ?? 0);
  if (!index || !l?.close_time) return null;
  return { index, closeTimeMs: (l.close_time + RIPPLE_EPOCH) * 1000 };
}

// ── transactions ───────────────────────────────────────────────────────────────────────────────────────────────────
export interface RlusdRef { issuer: string; hex: string }

export function buildTicketCreate(account: string, count: number): Record<string, unknown> {
  if (!Number.isInteger(count) || count < 1 || count > AUTOPAY_MAX_PERIODS) throw new Error(`ticket count must be 1–${AUTOPAY_MAX_PERIODS}`);
  return { TransactionType: "TicketCreate", Account: account, TicketCount: count };
}

/** Plain decimal → ledger Amount. XRP in drops (≤ 6 places); RLUSD as an issued-currency object. */
export function ledgerAmount(currency: AutopayCurrency, value: string, rlusd: RlusdRef): string | Record<string, string> {
  if (!/^\d+(\.\d+)?$/.test(value) || Number(value) <= 0) throw new Error("amount must be a positive decimal");
  if (currency === "XRP") {
    const [w, f = ""] = value.split(".");
    if (f.length > 6) throw new Error("XRP has at most 6 decimal places");
    return (BigInt(w) * BigInt(1_000_000) + BigInt((f + "000000").slice(0, 6))).toString();
  }
  return { currency: rlusd.hex, issuer: rlusd.issuer, value };
}

export interface PaymentSpec {
  account: string; destination: string; destinationTag: number | null;
  currency: AutopayCurrency; amount: string; ticket: number; lastLedger: number;
}
/** The exact Payment the payer pre-signs. No Flags: in particular never tfPartialPayment. */
export function buildAutopayPayment(p: PaymentSpec, rlusd: RlusdRef): Record<string, unknown> {
  return {
    TransactionType: "Payment",
    Account: p.account,
    Destination: p.destination,
    ...(p.destinationTag != null ? { DestinationTag: p.destinationTag } : {}),
    Amount: ledgerAmount(p.currency, p.amount, rlusd),
    Fee: AUTOPAY_FEE_DROPS,
    Sequence: 0,
    TicketSequence: p.ticket,
    LastLedgerSequence: p.lastLedger,
  };
}

/** Consumes one ticket and does nothing else — how the payer cancels the payment that ticket was signed for. */
export function buildTicketBurn(account: string, ticket: number): Record<string, unknown> {
  return { TransactionType: "AccountSet", Account: account, Sequence: 0, TicketSequence: ticket };
}

/** Up to 8 ticket burns in one single-account Batch (tfAllOrNothing). The outer Batch uses the account's sequence. */
export function buildTicketBurnBatch(account: string, sequence: number, tickets: number[]): Record<string, unknown> {
  if (!tickets.length || tickets.length > 8) throw new Error("a batch holds 1–8 tickets");
  return {
    TransactionType: "Batch",
    Account: account,
    Flags: 0x00010000, // tfAllOrNothing
    Sequence: sequence,
    RawTransactions: tickets.map((t) => ({ RawTransaction: { ...buildTicketBurn(account, t), Flags: TF_INNER_BATCH_TXN, Fee: "0", SigningPubKey: "" } })),
  };
}

// ── accepting a signed blob ────────────────────────────────────────────────────────────────────────────────────────
function sameAmount(a: unknown, b: unknown): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  const x = a as Record<string, string> | null, y = b as Record<string, string> | null;
  return !!x && !!y && x.currency === y.currency && x.issuer === y.issuer && Number(x.value) === Number(y.value);
}

/** Decode a signed blob and check it is EXACTLY the payment we asked for, validly signed. Returns its hash. */
export function acceptSignedBlob(hex: string, expected: Record<string, unknown>): { ok: true; hash: string; fee: string } | { ok: false; error: string } {
  let tx: Record<string, unknown>;
  try { tx = decode(hex) as Record<string, unknown>; } catch { return { ok: false, error: "the signed payment could not be decoded" }; }
  const keys: string[] = ["TransactionType", "Account", "Destination", "DestinationTag", "Sequence", "TicketSequence", "LastLedgerSequence"];
  for (const k of keys) {
    if ((tx[k] ?? null) !== (expected[k] ?? null)) return { ok: false, error: `the signed payment's ${k} (${String(tx[k])}) is not what was requested (${String(expected[k])})` };
  }
  if (!sameAmount(tx.Amount, expected.Amount)) return { ok: false, error: "the signed payment's amount is not what was requested" };
  const flags = Number(tx.Flags ?? 0) >>> 0;
  if ((flags & ~TF_FULLY_CANONICAL_SIG) !== 0) return { ok: false, error: `the signed payment carries unexpected flags (${flags})` };
  for (const k of ["SendMax", "DeliverMin", "Paths", "InvoiceID", "Signers", "Delegate"]) {
    if (tx[k] != null) return { ok: false, error: `the signed payment carries an unexpected ${k}` };
  }
  const fee = String(tx.Fee ?? "");
  if (!/^\d+$/.test(fee) || Number(fee) > AUTOPAY_MAX_FEE_DROPS) return { ok: false, error: `the signed payment's fee (${fee} drops) is too high` };
  if (!tx.SigningPubKey || !tx.TxnSignature) return { ok: false, error: "the payment is not signed (multi-signed accounts aren't supported)" };
  try { if (!verifySignature(hex)) return { ok: false, error: "the signature does not verify" }; } catch { return { ok: false, error: "the signature does not verify" }; }
  return { ok: true, hash: hashes.hashSignedTx(hex), fee };
}

// ── storage: blobs are encrypted at rest and bound to their row ───────────────────────────────────────────────────
const keyFrom = (secret: string) => createHash("sha256").update(`xrplhub-autopay|${secret}`).digest();
export function encryptBlob(hex: string, secret: string, rowId: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  c.setAAD(Buffer.from(rowId));
  const ct = Buffer.concat([c.update(hex, "utf8"), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64")}`;
}
export function decryptBlob(enc: string, secret: string, rowId: string): string {
  if (!enc.startsWith("v1:")) throw new Error("unknown blob format");
  const raw = Buffer.from(enc.slice(3), "base64");
  const d = createDecipheriv("aes-256-gcm", keyFrom(secret), raw.subarray(0, 12));
  d.setAAD(Buffer.from(rowId));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}

// ── ledger reads ───────────────────────────────────────────────────────────────────────────────────────────────────
/** The tickets a validated TicketCreate made (ascending). null = not validated yet / unreadable. */
export async function ticketsFromTx(rpc: Rpc, txHash: string, account: string): Promise<{ ok: true; tickets: number[] } | { ok: false; error: string; retry: boolean }> {
  const r = await rpc("tx", { transaction: txHash });
  if (!r) return { ok: false, error: "could not read the ledger", retry: true };
  if (r.error) return { ok: false, error: String(r.error), retry: r.error === "txnNotFound" };
  if (!r.validated) return { ok: false, error: "not validated yet", retry: true };
  const tx = (r.tx_json ?? r) as Record<string, unknown>;
  const meta = r.meta as { TransactionResult?: string; AffectedNodes?: { CreatedNode?: { LedgerEntryType?: string; NewFields?: { TicketSequence?: number; Account?: string } } }[] } | undefined;
  if (tx.TransactionType !== "TicketCreate" || tx.Account !== account) return { ok: false, error: "that transaction is not this payer's TicketCreate", retry: false };
  if (meta?.TransactionResult !== "tesSUCCESS") return { ok: false, error: `the TicketCreate failed (${meta?.TransactionResult})`, retry: false };
  const tickets = (meta.AffectedNodes ?? []).map((n) => n.CreatedNode).filter((c) => c?.LedgerEntryType === "Ticket").map((c) => Number(c!.NewFields!.TicketSequence)).sort((a, b) => a - b);
  return tickets.length ? { ok: true, tickets } : { ok: false, error: "the TicketCreate made no tickets", retry: false };
}

/** Ticket numbers the account still holds (null = unreadable). */
export async function ticketsOnLedger(rpc: Rpc, account: string): Promise<number[] | null> {
  const r = await rpc("account_objects", { account, type: "ticket", limit: 400, ledger_index: "validated" });
  if (!r || r.error) return r?.error === "actNotFound" ? [] : null;
  return ((r.account_objects as { TicketSequence?: number }[]) ?? []).map((o) => Number(o.TicketSequence)).sort((a, b) => a - b);
}

export interface PreflightInput { funder: string; payee: string; destinationTag: number | null; currency: AutopayCurrency; amount: string; periods: number }
/** Before any ticket is made: can these payments land, and can the payer afford the tickets' reserve? */
export async function autopayPreflight(rpc: Rpc, i: PreflightInput, rlusd: RlusdRef): Promise<{ ok: true; reservePerTicketXrp: number; reserveXrp: number } | { ok: false; error: string }> {
  const [payee, funder, state] = await Promise.all([
    rpc("account_info", { account: i.payee, ledger_index: "validated" }),
    rpc("account_info", { account: i.funder, ledger_index: "validated" }),
    rpc("server_state", {}),
  ]);
  if (!payee || !funder || !state) return { ok: false, error: "Could not read the XRP Ledger just now. Try again in a minute." };
  if (payee.error === "actNotFound") return { ok: false, error: "The account you pay doesn't exist on the XRP Ledger yet." };
  if (funder.error === "actNotFound") return { ok: false, error: "Your account doesn't exist on the XRP Ledger yet." };
  const pf = Number((payee.account_data as { Flags?: number })?.Flags ?? 0);
  if (pf & LSF_DEPOSIT_AUTH) return { ok: false, error: "The account you pay only accepts payments from accounts it has approved, so Autopay can't pay it. Keep using monthly checks." };
  if (pf & LSF_REQUIRE_DEST_TAG && i.destinationTag == null) return { ok: false, error: "The account you pay needs a destination tag. Add it to the plan first." };
  if (i.currency === "RLUSD") {
    const lines = await rpc("account_lines", { account: i.payee, peer: rlusd.issuer, ledger_index: "validated" });
    if (!lines) return { ok: false, error: "Could not read the XRP Ledger just now. Try again in a minute." };
    const line = ((lines.lines as { currency?: string; limit?: string; freeze_peer?: boolean; freeze?: boolean }[]) ?? []).find((l) => String(l.currency).toUpperCase() === rlusd.hex);
    if (!line || Number(line.limit) <= 0) return { ok: false, error: "The account you pay can't receive RLUSD yet (it hasn't added RLUSD to its wallet). Checks still work for it; Autopay doesn't." };
    if (line.freeze || line.freeze_peer) return { ok: false, error: "RLUSD is frozen for the account you pay." };
  }
  const vl = (state.state as { validated_ledger?: { reserve_base?: number; reserve_inc?: number } })?.validated_ledger;
  const inc = (vl?.reserve_inc ?? 200_000) / 1e6, base = (vl?.reserve_base ?? 1_000_000) / 1e6;
  const fd = funder.account_data as { Balance?: string; OwnerCount?: number };
  const spendable = Number(fd?.Balance ?? 0) / 1e6 - (base + inc * Number(fd?.OwnerCount ?? 0));
  const need = inc * i.periods + 0.001;
  if (spendable < need) return { ok: false, error: `Autopay needs ${Number((inc * i.periods).toFixed(6))} XRP free in your wallet for ${i.periods} tickets (${inc} XRP each). You have ${Math.max(0, Number(spendable.toFixed(6)))} XRP free.` };
  return { ok: true, reservePerTicketXrp: inc, reserveXrp: Number((inc * i.periods).toFixed(6)) };
}

// ── the scheduler ──────────────────────────────────────────────────────────────────────────────────────────────────
export interface DueRow { id: string; periodStart: Date; periodEnd: Date; status: RowStatus; blobEnc: string | null; txHash: string | null; attempts: number }
export type RowPatch = Partial<{ status: RowStatus; result: string; reason: string; submittedAt: Date; settledAt: Date; attempts: number }>;
export type Outcome = "waiting" | "submitted" | "paid" | "failed" | "missed" | "cancelled" | "retry" | "skipped";

/** Plain-English reason for a final ledger failure (shown to payer and payee). */
export function failureReason(code: string): string {
  switch (code) {
    case "tecUNFUNDED_PAYMENT": return "There wasn't enough XRP in the payer's wallet.";
    case "tecPATH_DRY":
    case "tecPATH_PARTIAL": return "There wasn't enough RLUSD in the payer's wallet, or the account being paid can't receive RLUSD.";
    case "tecNO_DST_INSUF_XRP": return "The account being paid doesn't exist yet and this payment is too small to create it.";
    case "tecNO_DST": return "The account being paid doesn't exist.";
    case "tecNO_PERMISSION": return "The account being paid only accepts payments from accounts it has approved.";
    case "tecDST_TAG_NEEDED": return "The account being paid needs a destination tag.";
    case "tecFROZEN": return "RLUSD is frozen for one of the accounts.";
    case "tefBAD_AUTH": return "The key that approved this payment can no longer sign for the payer's account.";
    default: return `The XRP Ledger refused the payment (${code}).`;
  }
}

/** Read a payment's final result. pending = not in a validated ledger yet. */
export async function finalResult(rpc: Rpc, hash: string): Promise<{ state: "pending" } | { state: "final"; code: string }> {
  const r = await rpc("tx", { transaction: hash });
  if (!r || r.error || !r.validated) return { state: "pending" };
  const code = String((r.meta as { TransactionResult?: string } | undefined)?.TransactionResult ?? "");
  return code ? { state: "final", code } : { state: "pending" };
}

/**
 * Process ONE autopay row at time `now`. Never submits before the period starts, never after its end + grace, never a
 * row that is already final. A tec result is final: no retry, `notify` is called. tel/ter or "not validated yet" leave
 * the row to be re-sent (same blob — it can only ever apply once) on the next run.
 */
export async function processRow(
  row: DueRow,
  ctx: {
    rpc: Rpc; now: Date; secret: string;
    update: (id: string, p: RowPatch) => Promise<void>;
    notify: (id: string, kind: "failed" | "missed", reason: string) => Promise<void>;
    /** After a submit, poll this long for the validated result so a failure is reported in the same run. */
    settleWaitMs?: number;
  }
): Promise<Outcome> {
  const { rpc, now } = ctx;
  if (row.status !== "scheduled" && row.status !== "pending") return "skipped";
  if (now.getTime() < row.periodStart.getTime()) return "waiting"; // NEVER early
  if (!row.blobEnc || !row.txHash) return "skipped";

  // Already on the ledger (submitted by an earlier run)? Settle it from the validated result.
  const seen = await finalResult(rpc, row.txHash);
  if (seen.state === "final") return settle(row, seen.code, ctx);

  if (now.getTime() >= row.periodEnd.getTime() + AUTOPAY_GRACE_S * 1000) {
    const reason = "Autopay couldn't send this payment during its week or month.";
    await ctx.update(row.id, { status: "missed", reason, settledAt: now });
    await ctx.notify(row.id, "missed", reason);
    return "missed";
  }

  let blob: string;
  try { blob = decryptBlob(row.blobEnc, ctx.secret, row.id); } catch {
    const reason = "The stored payment could not be read, so it was not sent.";
    await ctx.update(row.id, { status: "failed", result: "decrypt_failed", reason, settledAt: now });
    await ctx.notify(row.id, "failed", reason);
    return "failed";
  }
  const r = await rpc("submit", { tx_blob: blob });
  const code = String(r?.engine_result ?? "");
  const attempts = row.attempts + 1;
  if (!r || !code) { await ctx.update(row.id, { attempts, result: "no_answer" }); return "retry"; }

  if (code === "tesSUCCESS" || code === "terQUEUED" || code.startsWith("tec")) {
    // Provisionally applied (a tec still consumes the ticket). The validated ledger decides; next run settles it.
    await ctx.update(row.id, { status: "pending", result: code, attempts, submittedAt: row.status === "scheduled" ? now : undefined });
    const until = Date.now() + (ctx.settleWaitMs ?? 0);
    while (Date.now() < until) {
      await new Promise((s) => setTimeout(s, 1500));
      const f = await finalResult(rpc, row.txHash);
      if (f.state === "final") return settle(row, f.code, ctx);
    }
    return "submitted";
  }
  if (code === "tefNO_TICKET") {
    // The ticket is gone. If THIS payment used it, finalResult will see it; otherwise the payer cancelled.
    const again = await finalResult(rpc, row.txHash);
    if (again.state === "final") return settle(row, again.code, ctx);
    await ctx.update(row.id, { status: "cancelled", result: code, reason: "The payer cancelled Autopay.", settledAt: now, attempts });
    return "cancelled";
  }
  if (code === "tefMAX_LEDGER") {
    const reason = "This payment's approval had expired.";
    await ctx.update(row.id, { status: "missed", result: code, reason, settledAt: now, attempts });
    await ctx.notify(row.id, "missed", reason);
    return "missed";
  }
  if (code.startsWith("tef") || code.startsWith("tem")) {
    const reason = failureReason(code);
    await ctx.update(row.id, { status: "failed", result: code, reason, settledAt: now, attempts });
    await ctx.notify(row.id, "failed", reason);
    return "failed";
  }
  await ctx.update(row.id, { attempts, result: code }); // tel / ter: not applied, safe to send again next run
  return "retry";
}

async function settle(row: DueRow, code: string, ctx: { now: Date; update: (id: string, p: RowPatch) => Promise<void>; notify: (id: string, kind: "failed" | "missed", reason: string) => Promise<void> }): Promise<Outcome> {
  if (code === "tesSUCCESS") {
    await ctx.update(row.id, { status: "paid", result: code, settledAt: ctx.now });
    return "paid";
  }
  const reason = failureReason(code);
  await ctx.update(row.id, { status: "failed", result: code, reason, settledAt: ctx.now });
  await ctx.notify(row.id, "failed", reason);
  return "failed";
}

/** Shown wherever Autopay is offered (plain words; owner spec item 5). */
export function autopayDisclosure(reservePerTicketXrp: number, payeeLabel: string, amount: string, currency: string): string[] {
  return [
    "XRPLHub decides when each pre-approved payment is sent. We send exactly one at the start of each week or month, never early. You approve them all now, ahead of time, and we keep them encrypted.",
    `Each pre-approved payment holds ${reservePerTicketXrp} XRP in your wallet until it's used or released. You get the ${reservePerTicketXrp} XRP back then.`,
    `Each approved payment can only pay ${payeeLabel} exactly ${amount} ${currency}. It can't be changed or used for anything else.`,
    "Keep enough money in your wallet. If a payment fails (for example, not enough money), we don't try it again: we tell you and the person you pay, and send you a normal check to approve instead.",
    "To cancel, press Cancel: we stop sending at once. Then release each remaining payment (one small approval each). That makes it impossible to send, by anyone, and gives you back its XRP.",
    "Autopay is free. Each payment costs only the XRP Ledger's network fee (0.00002 XRP), paid from your wallet.",
  ];
}

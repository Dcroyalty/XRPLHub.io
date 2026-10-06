// src/lib/spendControls.ts
// Spend Controls — non-custodial spending plans on XRPL Checks (owner decisions 2026-10-05).
//
//   - A FUNDER makes a plan: up to 10 approved payees (address + label + category + budget per period), a period
//     (weekly / monthly) and a CHECK SIZE. Each payee's budget is split into checks of that size (plus one smaller
//     remainder check), so a merchant can be paid several times a period — a check is single-use.
//   - XRPLHub stores the plan, never funds or keys. Every check is an unsigned RLUSD CheckCreate the funder signs; the
//     merchant cashes with their own wallet (free); the funder cancels from the dashboard.
//   - FREE (2026-10-06): no plan fee, no prepay. Creating, signing and cashing checks are transactions Xaman offers free, and
//     Xaman deleted XRPLHub's original app for charging for those — so XRPLHub charges nothing here.
//   - Each open check holds 0.2 XRP of the funder's reserve (live from the ledger) until cashed or cancelled — shown up
//     front. Checks do NOT lock funds: the funder must keep the allowance in their wallet.
//   - Every check carries a deterministic InvoiceID, which is how the dashboard recognises it on the ledger. The ledger
//     is the truth for state; SpendCheck rows are refreshed from it (syncPlanChecks).
//   - One signature per check — until BatchV1_1 is active on mainnet AND a human has confirmed Xaman signs it
//     (SPEND_BATCH_XAMAN_VERIFIED=true, set only after that test). Then up to 8 checks per Batch signature.

import { createHash, randomBytes } from "crypto";
import type { PrismaClient } from "@prisma/client";
import { xrplRpc } from "./xrplNodes";
import { isValidXrplAddress } from "./address";
import { buildCheckCreate, RIPPLE_EPOCH } from "./checks";
import { RLUSD_HEX, RLUSD_ISSUER } from "./pricing";
import { getAmendmentStatus } from "./amendments";

export const MAX_PAYEES = 10;
export const MAX_CHECKS_PER_PERIOD = 50;
export const BATCH_MAX_INNER = 8; // BatchV1_1 limit
export const CATEGORIES = ["food", "groceries", "clothing", "school", "transport", "health", "housing", "utilities", "entertainment", "other"] as const;
export type Period = "weekly" | "monthly";

const LSF_REQUIRE_DEST_TAG = 0x00020000;
const LSF_DISALLOW_INCOMING_CHECK = 0x08000000;

// ── money: whole cents (RLUSD checks are priced to the cent) ─────────────────────────────────────────────────────
export function toCents(raw: unknown): number | null {
  const v = String(raw ?? "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return null;
  const [w, f = ""] = v.split(".");
  const c = Number(w) * 100 + Number((f + "00").slice(0, 2));
  return Number.isSafeInteger(c) && c > 0 ? c : null;
}
export const fromCents = (c: number) => (c % 100 === 0 ? String(c / 100) : (c / 100).toFixed(2));

/** A payee's budget split into checks of `checkSize` — full checks plus one remainder check. */
export function splitBudget(budgetCents: number, checkSizeCents: number): number[] {
  const full = Math.floor(budgetCents / checkSizeCents);
  const rest = budgetCents - full * checkSizeCents;
  return [...Array(full).fill(checkSizeCents), ...(rest > 0 ? [rest] : [])];
}

// ── periods (UTC): weekly = Monday 00:00 → next Monday; monthly = the 1st → the next 1st ──────────────────────────
export function periodWindow(period: Period, now = new Date()): { start: Date; end: Date } {
  if (period === "monthly") {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return { start, end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) };
  }
  const day = (now.getUTCDay() + 6) % 7; // Monday = 0
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day));
  return { start, end: new Date(start.getTime() + 7 * 86_400_000) };
}
export const toRipple = (d: Date) => Math.floor(d.getTime() / 1000) - RIPPLE_EPOCH;
export const fromRipple = (s: number) => new Date((s + RIPPLE_EPOCH) * 1000);

export function invoiceIdFor(planId: string, payeeId: string, periodStart: Date, seq: number): string {
  return createHash("sha256").update(`xrplhub-spend|${planId}|${payeeId}|${periodStart.toISOString()}|${seq}`).digest("hex").toUpperCase();
}
export const newShareToken = () => randomBytes(18).toString("base64url");

// ── ledger reads ────────────────────────────────────────────────────────────────────────────────────────────────
async function rpc(method: string, params: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const r = await xrplRpc(method, { ...params, ledger_index: "validated" });
  return r.ok ? ((r.body.result as Record<string, unknown>) ?? null) : null;
}

/** Owner reserve per object, in XRP, live from the ledger (0.2 as of 2026-10). */
export async function ownerReserveXrp(): Promise<number> {
  const r = await rpc("server_state", {});
  const inc = (r?.state as { validated_ledger?: { reserve_inc?: number } } | undefined)?.validated_ledger?.reserve_inc;
  return typeof inc === "number" && inc > 0 ? inc / 1e6 : 0.2;
}

export interface PayeeCheck { ok: boolean; error?: string; needsTag?: boolean }
export async function checkPayeeAccount(address: string, destinationTag: number | null): Promise<PayeeCheck> {
  if (!isValidXrplAddress(address)) return { ok: false, error: "not a valid XRPL address" };
  const r = await rpc("account_info", { account: address });
  if (!r) return { ok: false, error: "could not read the ledger just now — try again" };
  if (r.error === "actNotFound") return { ok: false, error: "this account does not exist on the XRP Ledger yet (it must be activated to receive checks)" };
  const flags = Number((r.account_data as { Flags?: number } | undefined)?.Flags ?? 0);
  if (flags & LSF_DISALLOW_INCOMING_CHECK) return { ok: false, error: "this account refuses incoming checks (DisallowIncomingCheck)" };
  if (flags & LSF_REQUIRE_DEST_TAG && destinationTag == null) return { ok: false, needsTag: true, error: "this account requires a destination tag — ask the merchant for theirs" };
  return { ok: true };
}

export async function rlusdBalance(account: string): Promise<number | null> {
  const r = await rpc("account_lines", { account, peer: RLUSD_ISSUER });
  if (!r) return null;
  if (r.error === "actNotFound") return 0;
  const line = ((r.lines as { currency?: string; balance?: string }[]) ?? []).find((l) => String(l.currency).toUpperCase() === RLUSD_HEX);
  return line ? Number(line.balance) : 0;
}

// ── plan creation input ─────────────────────────────────────────────────────────────────────────────────────────
export interface PayeeInput { address: string; label: string; category: string; budget: string; destinationTag?: number | null }
export interface PlanInput { funder: string; name?: string; period: string; checkSize: string; payees: PayeeInput[] }

export type ValidatedPlan = {
  ok: true;
  funder: string; name: string | null; period: Period; checkSizeCents: number;
  payees: (PayeeInput & { budgetCents: number; checks: number[] })[];
  totalChecks: number; totalBudgetCents: number;
} | { ok: false; error: string; field?: string };

export function validatePlanInput(i: PlanInput): ValidatedPlan {
  if (!isValidXrplAddress(i.funder ?? "")) return { ok: false, field: "funder", error: "the funder must be a valid XRPL address" };
  const period = i.period === "weekly" || i.period === "monthly" ? i.period : null;
  if (!period) return { ok: false, field: "period", error: "period must be weekly or monthly" };
  const size = toCents(i.checkSize);
  if (!size) return { ok: false, field: "checkSize", error: "check size must be an amount like 10 or 12.50" };
  const payees = Array.isArray(i.payees) ? i.payees : [];
  if (!payees.length) return { ok: false, field: "payees", error: "add at least one approved payee" };
  if (payees.length > MAX_PAYEES) return { ok: false, field: "payees", error: `a plan has at most ${MAX_PAYEES} payees` };
  const seen = new Set<string>();
  const out = [];
  for (const [n, p] of payees.entries()) {
    const address = String(p.address ?? "").trim();
    if (!isValidXrplAddress(address)) return { ok: false, field: `payees.${n}.address`, error: `payee ${n + 1}: not a valid XRPL address` };
    if (address === i.funder) return { ok: false, field: `payees.${n}.address`, error: `payee ${n + 1}: can't be the funder's own account` };
    const key = `${address}|${p.destinationTag ?? ""}`;
    if (seen.has(key)) return { ok: false, field: `payees.${n}.address`, error: `payee ${n + 1} is listed twice` };
    seen.add(key);
    const label = String(p.label ?? "").trim().slice(0, 60);
    if (!label) return { ok: false, field: `payees.${n}.label`, error: `payee ${n + 1}: give it a name, e.g. "Joe's Market"` };
    const category = String(p.category ?? "other").toLowerCase();
    if (!(CATEGORIES as readonly string[]).includes(category)) return { ok: false, field: `payees.${n}.category`, error: `payee ${n + 1}: category must be one of ${CATEGORIES.join(", ")}` };
    const budgetCents = toCents(p.budget);
    if (!budgetCents) return { ok: false, field: `payees.${n}.budget`, error: `payee ${n + 1}: budget must be an amount like 50 or 12.50` };
    const tag = p.destinationTag == null || p.destinationTag === ("" as unknown) ? null : Number(p.destinationTag);
    if (tag !== null && (!Number.isInteger(tag) || tag < 0 || tag > 4_294_967_295)) return { ok: false, field: `payees.${n}.destinationTag`, error: `payee ${n + 1}: destination tag must be a whole number` };
    out.push({ address, label, category, budget: fromCents(budgetCents), destinationTag: tag, budgetCents, checks: splitBudget(budgetCents, size) });
  }
  const totalChecks = out.reduce((a, p) => a + p.checks.length, 0);
  if (totalChecks > MAX_CHECKS_PER_PERIOD) {
    return { ok: false, field: "checkSize", error: `that makes ${totalChecks} checks a period — the limit is ${MAX_CHECKS_PER_PERIOD}. Use a bigger check size.` };
  }
  return { ok: true, funder: i.funder, name: i.name ? String(i.name).slice(0, 60) : null, period, checkSizeCents: size, payees: out, totalChecks, totalBudgetCents: out.reduce((a, p) => a + p.budgetCents, 0) };
}

// ── building the period's checks ────────────────────────────────────────────────────────────────────────────────
type PlanWithPayees = { id: string; funder: string; period: string; payees: { id: string; address: string; budget: string; destinationTag: number | null; position: number }[]; checkSize: string };

/** Create the SpendCheck rows for the CURRENT period (idempotent) and return every check row of the period. */
export async function ensurePeriodChecks(prisma: PrismaClient, plan: PlanWithPayees, now = new Date()) {
  const { start, end } = periodWindow(plan.period as Period, now);
  const size = toCents(plan.checkSize)!;
  const expiration = toRipple(end);
  for (const payee of [...plan.payees].sort((a, b) => a.position - b.position)) {
    const amounts = splitBudget(toCents(payee.budget)!, size);
    for (const [k, cents] of amounts.entries()) {
      const seq = k + 1;
      await prisma.spendCheck.upsert({
        where: { payeeId_periodStart_seq: { payeeId: payee.id, periodStart: start, seq } },
        create: { planId: plan.id, payeeId: payee.id, periodStart: start, seq, amount: fromCents(cents), expiration, invoiceId: invoiceIdFor(plan.id, payee.id, start, seq) },
        update: {},
      });
    }
  }
  return prisma.spendCheck.findMany({ where: { planId: plan.id, periodStart: start }, include: { payee: true }, orderBy: [{ payee: { position: "asc" } }, { seq: "asc" }] });
}

/** The unsigned CheckCreate for one SpendCheck row. */
export function checkCreateFor(funder: string, row: { amount: string; expiration: number; invoiceId: string; payee: { address: string; destinationTag: number | null } }) {
  return buildCheckCreate({
    account: funder,
    destination: row.payee.address,
    currency: "RLUSD",
    amount: row.amount,
    expiration: row.expiration,
    invoiceId: row.invoiceId,
    ...(row.payee.destinationTag != null ? { destinationTag: row.payee.destinationTag } : {}),
  });
}

// ── ledger sync: what happened to each check ────────────────────────────────────────────────────────────────────
type CheckNode = { index: string; InvoiceID?: string; Expiration?: number; SendMax?: unknown; Destination?: string };

/** Refresh every SpendCheck of a plan from the ledger: unsigned -> open (on ledger) -> expired / closed (cashed | cancelled). */
export async function syncPlanChecks(prisma: PrismaClient, planId: string, funder: string): Promise<{ ok: boolean; closeTime: number | null }> {
  // Also re-check closed rows whose "how" is still unknown (a history read can miss; the next sync fills it in).
  const rows = await prisma.spendCheck.findMany({ where: { planId, OR: [{ status: { in: ["unsigned", "open", "expired"] } }, { status: "closed", closedHow: null }] } });
  if (!rows.length) return { ok: true, closeTime: null };
  const objs = await rpc("account_objects", { account: funder, type: "check", limit: 400 });
  const ledger = await rpc("ledger", {});
  if (!objs || !ledger) return { ok: false, closeTime: null };
  const closeTime = Number((ledger.ledger as { close_time?: number } | undefined)?.close_time ?? 0) || null;
  const onLedger = new Map<string, CheckNode>();
  for (const o of (objs.account_objects as CheckNode[]) ?? []) if (o.InvoiceID) onLedger.set(String(o.InvoiceID).toUpperCase(), o);

  // Gone from the ledger: find how (CheckCash vs CheckCancel) in the funder's recent history.
  let history: { tx?: Record<string, unknown>; tx_json?: Record<string, unknown>; meta?: Record<string, unknown> }[] | null = null;
  const loadHistory = async () => {
    if (history) return history;
    // NO ledger_index here: on Clio (s1/s2.ripple.com) ledger_index:"validated" overrides ledger_index_min/max and
    // narrows account_tx to the current ledger only — the history comes back empty (found 2026-10-05).
    const h = await xrplRpc("account_tx", { account: funder, limit: 400, ledger_index_min: -1, ledger_index_max: -1 });
    history = h.ok ? (((h.body.result as Record<string, unknown>)?.transactions as typeof history) ?? []) : [];
    return history;
  };
  const created = new Map<string, string>(); // invoiceId -> checkId from a CheckCreate we never saw on the ledger
  const closedBy = new Map<string, string>(); // checkId -> "cashed" | "cancelled"
  if (rows.some((r) => !onLedger.has(r.invoiceId))) {
    for (const t of await loadHistory()) {
      const tx = (t.tx_json ?? t.tx ?? {}) as Record<string, unknown>;
      const nodes = ((t.meta as { AffectedNodes?: Record<string, { LedgerEntryType?: string; LedgerIndex?: string; NewFields?: { InvoiceID?: string } }>[] })?.AffectedNodes) ?? [];
      if ((t.meta as { TransactionResult?: string })?.TransactionResult !== "tesSUCCESS") continue;
      for (const n of nodes) {
        const c = n.CreatedNode, d = n.DeletedNode;
        if (c?.LedgerEntryType === "Check" && c.NewFields?.InvoiceID) created.set(String(c.NewFields.InvoiceID).toUpperCase(), String(c.LedgerIndex));
        if (d?.LedgerEntryType === "Check") closedBy.set(String(d.LedgerIndex), tx.TransactionType === "CheckCash" ? "cashed" : "cancelled");
      }
    }
  }

  for (const r of rows) {
    const node = onLedger.get(r.invoiceId);
    if (node) {
      const expired = !!(closeTime && node.Expiration && closeTime >= node.Expiration);
      const status = expired ? "expired" : "open";
      if (r.status !== status || r.checkId !== node.index) await prisma.spendCheck.update({ where: { id: r.id }, data: { status, checkId: node.index } });
      continue;
    }
    const checkId = r.checkId ?? created.get(r.invoiceId) ?? null;
    if (!checkId) continue; // never created: stays unsigned
    const how = closedBy.get(checkId) ?? null;
    if (r.status === "closed" && !how) continue; // still unknown — try again next sync
    await prisma.spendCheck.update({ where: { id: r.id }, data: { status: "closed", checkId, closedHow: how } });
  }
  return { ok: true, closeTime };
}

// ── one-signature Batch (gated) ─────────────────────────────────────────────────────────────────────────────────
export async function batchAvailability(): Promise<{ available: boolean; reason: string }> {
  const s = await getAmendmentStatus("BatchV1_1");
  if (s.state !== "active") {
    return { available: false, reason: s.state === "unknown" ? "could not read the ledger" : `BatchV1_1 is not active on mainnet yet${s.earliestActivation ? ` (earliest ${s.earliestActivation})` : ""}` };
  }
  if (process.env.SPEND_BATCH_XAMAN_VERIFIED !== "true") return { available: false, reason: "Batch is active, but signing it in Xaman has not been verified yet" };
  return { available: true, reason: "ok" };
}

/** A single-account Batch (tfAllOrNothing) of up to 8 CheckCreates. Inner Sequences follow the outer one, so the funder
 *  must not send any other transaction before signing. xrpl.js 4.6 handles single-account batches (no BatchSigners). */
export async function buildChecksBatch(funder: string, inner: Record<string, unknown>[]): Promise<{ ok: true; txjson: Record<string, unknown> } | { ok: false; error: string }> {
  if (!inner.length || inner.length > BATCH_MAX_INNER) return { ok: false, error: `a batch holds 1–${BATCH_MAX_INNER} checks` };
  const info = await rpc("account_info", { account: funder });
  const seq = Number((info?.account_data as { Sequence?: number } | undefined)?.Sequence ?? 0);
  if (!seq) return { ok: false, error: "could not read the funder's account sequence" };
  const txjson = {
    TransactionType: "Batch",
    Account: funder,
    Flags: 0x00010000, // tfAllOrNothing
    Sequence: seq,
    RawTransactions: inner.map((t, k) => ({ RawTransaction: { ...t, Flags: 0x40000000, Sequence: seq + 1 + k, Fee: "0", SigningPubKey: "" } })),
  };
  try {
    const { validate } = await import("xrpl");
    validate({ ...txjson, Fee: "12" } as Parameters<typeof validate>[0]);
  } catch (e) {
    return { ok: false, error: `batch failed validation: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true, txjson };
}

// src/lib/spendAutopay.ts
// Spend Controls AUTOPAY — the glue between the ledger core (autopay.ts), the database, Xaman and the daily crons.
//
//   start    → preflight, then ONE TicketCreate sign request (Xaman submits it)                      autopayStatus "tickets"
//   tickets  → read the validated TicketCreate, make one row per future period (next period onward)   autopayStatus "signing"
//   sign     → a submit:false Xaman request for the next unsigned row (our far-future LastLedgerSequence)
//   signed   → read the blob from Xaman, check it is EXACTLY that payment, encrypt, store             autopayStatus "on" when all done
//   cancel   → stop at once (unsigned/scheduled rows → cancelled), then the payer burns the remaining tickets
//   cron     → runAutopayDue(): one payment per period, never early; failures are reported, never retried
//
// The current period is always paid the normal way (a check); Autopay starts with the NEXT period, so the two never
// overlap. A period covered by Autopay gets no check push and its check can't be signed (autopayCovers).

import type { PrismaClient, SpendAutopayPayment } from "@prisma/client";
import { xrplRpc } from "./xrplNodes";
import { RLUSD_HEX, RLUSD_ISSUER } from "./pricing";
import { createPayload, getPayloadStatus, safeIdentifier, xummConfigured } from "./xumm";
import { notifyError, notifyInfo } from "./notify";
import { batchAvailability, ownerReserveXrp } from "./spendControls";
import {
  AUTOPAY_GRACE_S, AUTOPAY_MAX_PERIODS, acceptSignedBlob, autopayDisclosure, autopayPeriods, autopayPreflight,
  buildAutopayPayment, buildTicketBurn, buildTicketBurnBatch, buildTicketCreate, encryptBlob, lastLedgerFor, processRow,
  ticketsFromTx, ticketsOnLedger, validatedLedger, type AutopayCurrency, type AutopayPeriod, type Rpc, type RowStatus,
} from "./autopay";

export const RLUSD = { issuer: RLUSD_ISSUER, hex: RLUSD_HEX };
export const mainnetRpc: Rpc = async (method, params) => {
  const r = await xrplRpc(method, params);
  return r.ok ? ((r.body.result as Record<string, unknown>) ?? null) : null;
};

/** The at-rest key. Autopay refuses to start (and the cron refuses to send) without it. */
export function autopaySecret(): string | null {
  const k = process.env.SPEND_AUTOPAY_KEY;
  return k && k.length >= 32 ? k : null;
}

type Plan = {
  id: string; funder: string; name: string | null; kind: string; status: string; period: string; currency: string;
  autopayStatus: string; autopayTicketUuid: string | null; autopayPeriods: number | null; xamanUserToken: string | null;
  payees: { address: string; label: string; budget: string; destinationTag: number | null }[];
};
const payeeOf = (p: Plan) => p.payees[0];
const LIVE: RowStatus[] = ["scheduled", "pending", "paid"];
const OPEN: RowStatus[] = ["unsigned", "scheduled", "pending"];

export type Fail = { ok: false; status: number; error: string; message: string };
const fail = (status: number, error: string, message: string): Fail => ({ ok: false, status, error, message });

function txFor(plan: Plan, row: Pick<SpendAutopayPayment, "ticket" | "amount" | "lastLedger">) {
  const p = payeeOf(plan);
  return buildAutopayPayment({
    account: plan.funder, destination: p.address, destinationTag: p.destinationTag, currency: plan.currency as AutopayCurrency,
    amount: row.amount, ticket: row.ticket, lastLedger: row.lastLedger,
  }, RLUSD);
}

async function xamanRequest(txjson: Record<string, unknown>, label: string, planId: string, submit: boolean) {
  const p = await createPayload({
    txjson, submit, identifier: safeIdentifier("xrplhub_spend_", planId.slice(0, 16), `_${Date.now()}`),
    instruction: `XRPLHub Spend Controls — ${label}`,
  });
  return { uuid: p.uuid, qr_png: p.qrPng, deep_link: p.deepLink, websocket: p.websocket ?? null };
}

// ── start ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export async function startAutopay(prisma: PrismaClient, plan: Plan, periodsRaw: unknown) {
  if (plan.kind !== "subscription") return fail(409, "not_subscription", "Autopay is only for recurring payments.");
  if (plan.status !== "active" && plan.status !== "draft") return fail(409, "plan_ended", "This plan has ended.");
  if (!autopaySecret()) return fail(503, "autopay_unavailable", "Autopay isn't switched on yet. Monthly checks still work.");
  if (!xummConfigured()) return fail(503, "xaman_unavailable", "Xaman isn't reachable right now. Try again later.");
  const periods = Number(periodsRaw);
  if (!Number.isInteger(periods) || periods < 1 || periods > AUTOPAY_MAX_PERIODS) return fail(400, "bad_periods", `Pick 1 to ${AUTOPAY_MAX_PERIODS} payments.`);
  const open = await prisma.spendAutopayPayment.count({ where: { planId: plan.id, status: { in: OPEN } } });
  if (open) return fail(409, "autopay_active", "Autopay is already set up for this plan. Cancel it first to start over.");
  const p = payeeOf(plan);
  const pre = await autopayPreflight(mainnetRpc, {
    funder: plan.funder, payee: p.address, destinationTag: p.destinationTag, currency: plan.currency as AutopayCurrency, amount: p.budget, periods,
  }, RLUSD);
  if (!pre.ok) return fail(422, "preflight_failed", pre.error);
  const sign = await xamanRequest(buildTicketCreate(plan.funder, periods), `Autopay setup: ${periods} ticket${periods === 1 ? "" : "s"} (sets aside ${pre.reserveXrp} XRP until used)`, plan.id, true)
    .catch(() => null);
  if (!sign) return fail(502, "xaman_unavailable", "Xaman couldn't create the request just now. Try again.");
  await prisma.spendPlan.update({ where: { id: plan.id }, data: { autopayStatus: "tickets", autopayTicketUuid: sign.uuid, autopayPeriods: periods } });
  return { ok: true as const, step: "tickets", txjson: buildTicketCreate(plan.funder, periods), ...sign, reserveXrp: pre.reserveXrp };
}

// ── tickets: the TicketCreate was signed → one row per future period ───────────────────────────────────────────────
export async function confirmTickets(prisma: PrismaClient, plan: Plan, now = new Date()) {
  if (plan.autopayStatus !== "tickets" || !plan.autopayTicketUuid) return fail(409, "not_waiting", "There's no Autopay setup waiting for tickets.");
  const st = await getPayloadStatus(plan.autopayTicketUuid).catch(() => null);
  if (!st) return fail(502, "xaman_unreachable", "Couldn't read the request from Xaman just now.");
  if (st.state === "pending") return { ok: true as const, state: "waiting" };
  if (st.state !== "signed") {
    await prisma.spendPlan.update({ where: { id: plan.id }, data: { autopayStatus: "off", autopayTicketUuid: null } });
    return { ok: true as const, state: st.state === "expired" ? "expired" : "declined" };
  }
  if (st.signer !== plan.funder || !st.identifier?.startsWith("xrplhub_spend_") || !st.txid) return fail(403, "wrong_signer", "That request wasn't signed by this plan's payer.");
  const tk = await ticketsFromTx(mainnetRpc, st.txid, plan.funder);
  if (!tk.ok) {
    if (tk.retry) return { ok: true as const, state: "confirming" };
    await prisma.spendPlan.update({ where: { id: plan.id }, data: { autopayStatus: "off", autopayTicketUuid: null } });
    return fail(422, "tickets_failed", `The ticket setup didn't work: ${tk.error}.`);
  }
  const made = await createAutopayRows(prisma, plan, tk.tickets, autopayPeriods(plan.period as AutopayPeriod, now, tk.tickets.length), mainnetRpc, st.userToken ?? null);
  return made ? { ok: true as const, state: "ready", tickets: tk.tickets.length } : { ok: true as const, state: "confirming" };
}

/** One unsigned row per (ticket, period). Production periods come from autopayPeriods (weekly / monthly only); the
 *  Testnet cycle test passes minutes-long periods here. false = the ledger couldn't be read (try again). */
export async function createAutopayRows(prisma: PrismaClient, plan: Plan, tickets: number[], periods: { start: Date; end: Date }[], rpc: Rpc = mainnetRpc, userToken: string | null = null): Promise<boolean> {
  const ledger = await validatedLedger(rpc);
  if (!ledger) return false;
  const amount = payeeOf(plan).budget;
  await prisma.$transaction([
    prisma.spendAutopayPayment.createMany({
      data: periods.slice(0, tickets.length).map((p, k) => ({
        planId: plan.id, periodStart: p.start, periodEnd: p.end, ticket: tickets[k], amount,
        lastLedger: lastLedgerFor(new Date(p.end.getTime() + AUTOPAY_GRACE_S * 1000), ledger),
      })),
      skipDuplicates: true,
    }),
    prisma.spendPlan.update({ where: { id: plan.id }, data: { autopayStatus: "signing", autopayTicketUuid: null, ...(userToken ? { xamanUserToken: userToken } : {}) } }),
  ]);
  return true;
}

// ── sign: pre-approve the next payment ─────────────────────────────────────────────────────────────────────────────
export async function nextSignRequest(prisma: PrismaClient, plan: Plan, now = new Date()) {
  if (plan.autopayStatus !== "signing") return fail(409, "not_signing", "There's no payment waiting to be approved.");
  const rows = await prisma.spendAutopayPayment.findMany({ where: { planId: plan.id, status: "unsigned" }, orderBy: { periodStart: "asc" } });
  for (const row of rows) {
    if (now >= row.periodStart) {
      // Its period already began (it would overlap that period's check) — never send it. Its ticket shows under "release".
      await prisma.spendAutopayPayment.update({ where: { id: row.id }, data: { status: "cancelled", reason: "Not approved before its week or month began." } });
      continue;
    }
    // This setup = the rows created with this one (createMany stamps them together).
    const batch = await prisma.spendAutopayPayment.findMany({ where: { planId: plan.id, createdAt: { gte: new Date(row.createdAt.getTime() - 60_000) } }, select: { status: true } });
    const total = batch.filter((b) => b.status !== "cancelled").length;
    const done = batch.filter((b) => b.status === "scheduled" || b.status === "pending" || b.status === "paid").length;
    const when = row.periodStart.toISOString().slice(0, 10);
    const sign = await xamanRequest(txFor(plan, row), `Autopay ${done + 1} of ${total}: approve now, we send it on ${when}. Approving does NOT send it.`, plan.id, false).catch(() => null);
    if (!sign) return fail(502, "xaman_unavailable", "Xaman couldn't create the request just now. Try again.");
    await prisma.spendAutopayPayment.update({ where: { id: row.id }, data: { signUuid: sign.uuid } });
    return { ok: true as const, step: "sign", index: done + 1, total, periodStart: row.periodStart, amount: row.amount, currency: plan.currency, txjson: txFor(plan, row), ...sign };
  }
  await finishSigning(prisma, plan.id);
  return fail(409, "nothing_to_sign", "Every payment is already approved.");
}

async function finishSigning(prisma: PrismaClient, planId: string) {
  const left = await prisma.spendAutopayPayment.count({ where: { planId, status: "unsigned" } });
  const live = await prisma.spendAutopayPayment.count({ where: { planId, status: { in: ["scheduled", "pending"] } } });
  if (!left) await prisma.spendPlan.update({ where: { id: planId }, data: { autopayStatus: live ? "on" : "ended" } });
}

// ── signed: store the approved payment ─────────────────────────────────────────────────────────────────────────────
export async function acceptSigned(prisma: PrismaClient, plan: Plan, uuid: string) {
  const secret = autopaySecret();
  if (!secret) return fail(503, "autopay_unavailable", "Autopay isn't switched on yet.");
  const row = await prisma.spendAutopayPayment.findFirst({ where: { planId: plan.id, signUuid: uuid } });
  if (!row) return fail(404, "not_found", "That isn't an Autopay request for this plan.");
  if (row.status !== "unsigned") return { ok: true as const, state: row.status };
  const st = await getPayloadStatus(uuid).catch(() => null);
  if (!st) return fail(502, "xaman_unreachable", "Couldn't read the request from Xaman just now.");
  if (st.state !== "signed") return { ok: true as const, state: st.state };
  if (st.signer !== plan.funder) return fail(403, "wrong_signer", "That request was signed by a different account than this plan's payer.");
  if (!st.hex) return fail(502, "no_blob", "Xaman didn't return the approved payment. Approve it again.");
  const stored = await storeApproved(prisma, plan, row, st.hex, secret);
  if (!stored.ok) return stored;
  if (st.userToken && st.userToken !== plan.xamanUserToken) await prisma.spendPlan.update({ where: { id: plan.id }, data: { xamanUserToken: st.userToken } });
  return { ok: true as const, state: "scheduled", periodStart: row.periodStart };
}

/** Check a signed blob is EXACTLY this row's payment, then encrypt and schedule it. (Xaman hands us the blob in
 *  production; the Testnet cycle test signs with a faucet wallet and calls this directly.) */
export async function storeApproved(prisma: PrismaClient, plan: Plan, row: SpendAutopayPayment, hex: string, secret: string) {
  const acc = acceptSignedBlob(hex, txFor(plan, row));
  if (!acc.ok) {
    await notifyError("spend autopay acceptSigned", new Error(acc.error), { planId: plan.id, row: row.id });
    return fail(422, "blob_mismatch", `That approval can't be used: ${acc.error}. Approve it again.`);
  }
  await prisma.spendAutopayPayment.update({ where: { id: row.id }, data: { status: "scheduled", blobEnc: encryptBlob(hex, secret, row.id), txHash: acc.hash } });
  await finishSigning(prisma, plan.id);
  return { ok: true as const };
}

/** The txjson a row's payer pre-approves (exported for the Testnet cycle test). */
export const autopayTxFor = (plan: Plan, row: Pick<SpendAutopayPayment, "ticket" | "amount" | "lastLedger">) => txFor(plan, row);

// ── cancel + release ───────────────────────────────────────────────────────────────────────────────────────────────
/** Stop at once: nothing unsigned or scheduled will ever be sent by us. A payment already sent can't be pulled back. */
export async function cancelAutopay(prisma: PrismaClient, plan: Plan) {
  const r = await prisma.spendAutopayPayment.updateMany({
    where: { planId: plan.id, status: { in: ["unsigned", "scheduled"] } },
    data: { status: "cancelled", reason: "Cancelled by the payer." },
  });
  await prisma.spendPlan.update({ where: { id: plan.id }, data: { autopayStatus: "ended", autopayTicketUuid: null } });
  return { ok: true as const, cancelled: r.count };
}

/** Our tickets still on the ledger whose payment will never be sent (cancelled / never approved / plan ended). */
export async function releasableTickets(prisma: PrismaClient, plan: Plan, rpc: Rpc = mainnetRpc): Promise<number[] | null> {
  const rows = await prisma.spendAutopayPayment.findMany({ where: { planId: plan.id }, select: { ticket: true, status: true } });
  if (!rows.length) return [];
  const onLedger = await ticketsOnLedger(rpc, plan.funder);
  if (!onLedger) return null;
  const held = new Set(onLedger);
  return rows.filter((r) => held.has(r.ticket) && (r.status === "cancelled" || r.status === "missed" || (r.status === "unsigned" && plan.autopayStatus === "ended"))).map((r) => r.ticket).sort((a, b) => a - b);
}

/** A sign request that uses up tickets (one, or up to 8 in one Batch once Batch is verified in Xaman). */
export async function releaseRequest(prisma: PrismaClient, plan: Plan, ticketsRaw: unknown) {
  const want = (Array.isArray(ticketsRaw) ? ticketsRaw : [ticketsRaw]).map(Number).filter(Number.isInteger);
  const free = await releasableTickets(prisma, plan);
  if (!free) return fail(503, "ledger_unreachable", "Couldn't read your tickets from the ledger just now.");
  const tickets = want.filter((t) => free.includes(t));
  if (!tickets.length) return fail(404, "not_releasable", "None of those tickets can be released (they're already used, or still scheduled — cancel Autopay first).");
  let txjson: Record<string, unknown>;
  if (tickets.length > 1) {
    const b = await batchAvailability();
    if (!b.available) return fail(409, "batch_unavailable", `Releasing several at once isn't available yet: ${b.reason}. Release them one at a time.`);
    const info = await mainnetRpc("account_info", { account: plan.funder, ledger_index: "validated" });
    const seq = Number((info?.account_data as { Sequence?: number } | undefined)?.Sequence ?? 0);
    if (!seq) return fail(503, "ledger_unreachable", "Couldn't read your account just now.");
    txjson = buildTicketBurnBatch(plan.funder, seq, tickets.slice(0, 8));
  } else {
    txjson = buildTicketBurn(plan.funder, tickets[0]);
  }
  const label = tickets.length > 1 ? `release ${Math.min(8, tickets.length)} Autopay tickets` : `release Autopay ticket ${tickets[0]} (cancels its payment for good, returns its XRP)`;
  const sign = await xamanRequest(txjson, label, plan.id, true).catch(() => null);
  if (!sign) return fail(502, "xaman_unavailable", "Xaman couldn't create the request just now. Try again.");
  return { ok: true as const, tickets: tickets.slice(0, 8), txjson, ...sign };
}

// ── what the dashboard / share link / check flow need ──────────────────────────────────────────────────────────────
/** The Autopay row that answers "is this period paid?": the latest non-cancelled row starting inside the window that
 *  has already started. (Production rows start exactly at the window's start; the Testnet test's rows are shorter.) */
export async function autopayRowFor(prisma: PrismaClient, planId: string, window: { start: Date; end: Date }, now = new Date()) {
  return prisma.spendAutopayPayment.findFirst({
    where: { planId, status: { not: "cancelled" }, periodStart: { gte: window.start, lt: window.end, lte: now } },
    orderBy: { periodStart: "desc" },
  });
}

/** Is this period paid by Autopay (so no check should be pushed or signed for it)? Failed/missed rows don't cover. */
export async function autopayCovers(prisma: PrismaClient, planId: string, window: { start: Date; end: Date }, now = new Date()): Promise<{ covered: boolean; failedReason: string | null }> {
  const r = await autopayRowFor(prisma, planId, window, now);
  if (!r) return { covered: false, failedReason: null };
  if (LIVE.includes(r.status as RowStatus)) return { covered: true, failedReason: null };
  return { covered: false, failedReason: r.status === "failed" || r.status === "missed" ? r.reason : null };
}

export async function autopayView(prisma: PrismaClient, plan: Plan) {
  const rows = await prisma.spendAutopayPayment.findMany({ where: { planId: plan.id }, orderBy: { periodStart: "asc" }, take: 60 });
  const [reserve, releasable] = await Promise.all([ownerReserveXrp(), rows.length ? releasableTickets(prisma, plan) : Promise.resolve([] as number[])]);
  const p = payeeOf(plan);
  return {
    available: !!autopaySecret() && plan.kind === "subscription",
    status: plan.autopayStatus,
    maxPeriods: AUTOPAY_MAX_PERIODS,
    reservePerTicketXrp: reserve,
    payments: rows.map((r) => ({
      ticket: r.ticket, periodStart: r.periodStart, periodEnd: r.periodEnd, amount: r.amount, status: r.status, reason: r.reason,
      txHash: r.status === "paid" || r.status === "failed" || r.status === "pending" ? r.txHash : null, // the blob itself is never returned
    })),
    releasableTickets: releasable,
    disclosure: p ? autopayDisclosure(reserve, p.label, p.budget, plan.currency) : [],
  };
}

// ── cron ───────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Send every due Autopay payment (period started, still in its window). Bounded; never throws. */
export async function runAutopayDue(prisma: PrismaClient, opts: { budgetMs?: number; now?: Date; rpc?: Rpc; settleWaitMs?: number } = {}) {
  const out = { due: 0, paid: 0, failed: 0, missed: 0, cancelled: 0, pending: 0, waiting: 0, skipped: 0, retry: 0, sent: [] as string[], notices: [] as string[] };
  const secret = autopaySecret();
  if (!secret) return { ...out, disabled: true };
  const started = Date.now(), budgetMs = opts.budgetMs ?? 15_000;
  try {
    const now = opts.now ?? new Date();
    const rows = await prisma.spendAutopayPayment.findMany({
      where: { status: { in: ["scheduled", "pending"] }, periodStart: { lte: now } },
      include: { plan: { select: { id: true, name: true, funder: true, currency: true, payees: { select: { label: true }, take: 1 } } } },
      orderBy: { periodStart: "asc" }, take: 50,
    });
    for (const row of rows) {
      if (Date.now() - started > budgetMs) break;
      out.due++;
      const o = await processRow(
        { id: row.id, periodStart: row.periodStart, periodEnd: row.periodEnd, status: row.status as RowStatus, blobEnc: row.blobEnc, txHash: row.txHash, attempts: row.attempts },
        {
          rpc: opts.rpc ?? mainnetRpc, now, secret, settleWaitMs: opts.settleWaitMs ?? 8_000,
          update: async (id, patch) => { await prisma.spendAutopayPayment.update({ where: { id }, data: patch }); },
          // Payer: the subscription prompt that runs right after this pushes a normal check to their Xaman app with the
          // reason (autopayCovers → failedReason). Payee: their share link shows the failure. Owner: `notices` go into
          // the cron's healthchecks.io ping as RED lines — that is the channel that emails the owner (ERROR_WEBHOOK_URL
          // is not read by anyone).
          notify: async (id, kind, reason) => {
            await prisma.spendAutopayPayment.update({ where: { id }, data: { notifiedAt: new Date() } });
            const line = `autopay ${kind}: plan ${row.plan.id} (${row.plan.name ?? "subscription"}), ${row.amount} ${row.plan.currency} to ${row.plan.payees[0]?.label ?? "payee"} — ${reason} No retry; the payer is sent a normal check.`;
            out.notices.push(line);
            await notifyInfo("spend autopay", line);
          },
        }
      ).catch(async (e) => { await notifyError("spend autopay processRow", e, { row: row.id }); return "retry" as const; });
      if (o === "submitted" || o === "paid") out.sent.push(row.id);
      if (o === "submitted") out.pending++;
      else if (o === "paid" || o === "failed" || o === "missed" || o === "cancelled" || o === "waiting" || o === "skipped" || o === "retry") out[o]++;
    }
    // A plan whose every payment is final has nothing left on Autopay.
    const onPlans = await prisma.spendPlan.findMany({ where: { autopayStatus: "on" }, select: { id: true }, take: 200 });
    for (const p of onPlans) {
      const live = await prisma.spendAutopayPayment.count({ where: { planId: p.id, status: { in: ["unsigned", "scheduled", "pending"] } } });
      if (!live) await prisma.spendPlan.update({ where: { id: p.id }, data: { autopayStatus: "ended" } });
    }
  } catch (e) {
    await notifyError("spend autopay runAutopayDue", e);
  }
  return out;
}

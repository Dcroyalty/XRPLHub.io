// src/app/api/spend/plans/[id]/route.ts
// GET /api/spend/plans/:id — the funder dashboard. Refreshes every check from the ledger first (unsigned / open /
// expired / closed-as-cashed-or-cancelled), then returns this period's checks — each unsigned one with its ready-to-sign
// CheckCreate — the reserve currently held and whether one-signature Batch is available. Plans are free (2026-10-06).
// Read-only. The plan id is the dashboard's secret; every action it offers builds a transaction only the funder can sign.

import { prisma } from "@/lib/xrplscore-db";
import { rateLimit, rateLimited } from "@/lib/rateLimit";
import { batchAvailability, checkCreateFor, ensurePeriodChecks, fromRipple, funderBalance, ownerReserveXrp, periodWindow, syncPlanChecks, type PlanCurrency, type Period } from "@/lib/spendControls";
import { SPEND_DISCLOSURE, loadPlan, spendErr, spendJson } from "@/lib/spendApi";
import { autopayCovers, autopayView } from "@/lib/spendAutopay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 25;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const rl = rateLimit(req, "spend-dashboard", 30, 60_000);
  if (!rl.ok) return rateLimited(rl);
  const { id } = await ctx.params;
  const plan = await loadPlan(id);
  if (!plan) return spendErr(404, "not_found", "No plan with that id.");

  // Free: every plan is live. (Plans created before 2026-10-06 may still carry an old paidThrough; it no longer matters.)
  const paid = true;
  await ensurePeriodChecks(prisma, plan);
  const sync = await syncPlanChecks(prisma, plan.id, plan.funder);

  const { start, end } = periodWindow(plan.period as Period);
  const [rows, reserve, balance, batch, payments] = await Promise.all([
    prisma.spendCheck.findMany({ where: { planId: plan.id }, include: { payee: true }, orderBy: [{ periodStart: "desc" }, { payee: { position: "asc" } }, { seq: "asc" }], take: 300 }),
    ownerReserveXrp(),
    funderBalance(plan.funder, plan.currency as PlanCurrency),
    batchAvailability(),
    prisma.spendPlanPayment.findMany({ where: { planId: plan.id }, orderBy: { paidAt: "desc" } }),
  ]);
  const sub = plan.kind === "subscription";
  const [autopay, covers] = sub ? await Promise.all([autopayView(prisma, plan), autopayCovers(prisma, plan.id, start)]) : [null, null];
  const holding = rows.filter((r) => r.status === "open" || r.status === "expired").length;
  const current = rows.filter((r) => r.periodStart.getTime() === start.getTime());
  const view = (r: (typeof rows)[number]) => {
    const coveredByAutopay = !!covers?.covered && r.periodStart.getTime() === start.getTime();
    const tx = r.status === "unsigned" && paid && !coveredByAutopay ? checkCreateFor(plan.funder, r, plan.currency) : null;
    return {
      invoiceId: r.invoiceId, checkId: r.checkId, payee: r.payee.label, payeeAddress: r.payee.address, category: r.payee.category,
      seq: r.seq, amount: r.amount, currency: plan.currency, expires: fromRipple(r.expiration).toISOString(),
      status: coveredByAutopay && r.status === "unsigned" ? "autopay" : r.status, closedHow: r.closedHow, txjson: tx && tx.ok ? tx.txjson : null,
    };
  };
  return spendJson({
    plan: { id: plan.id, name: plan.name, kind: plan.kind, funder: plan.funder, period: plan.period, checkSize: plan.checkSize, currency: plan.currency, status: plan.status, paidThrough: plan.paidThrough, shareLink: `/spend/s/${plan.shareToken}` },
    payees: plan.payees.map((p) => ({ label: p.label, category: p.category, address: p.address, budget: p.budget, destinationTag: p.destinationTag })),
    paid,
    price: { free: true },
    period: { start, end },
    current: current.map(view),
    history: rows.filter((r) => r.periodStart.getTime() !== start.getTime()).slice(0, 100).map(view),
    reserve: { perCheckXrp: reserve, heldNowXrp: Number((reserve * holding).toFixed(6)), openChecks: holding, note: "Comes back as each check is cashed or cancelled. Expired checks still hold it until someone cancels them — cancel them here." },
    funderBalance: balance,
    funderRlusd: plan.currency === "RLUSD" ? balance : null,
    // Subscriptions: whether the daily job can push next period's check to the funder's Xaman app (a token exists after
    // their first signed Spend request). The token itself is never returned.
    pushReady: !!plan.xamanUserToken,
    ledgerSynced: sync.ok,
    batch,
    payments: payments.map((p) => ({ txHash: p.txHash, months: p.months, amount: p.amount, paidAt: p.paidAt })),
    disclosure: SPEND_DISCLOSURE,
    // Subscriptions only: Autopay status, schedule and releasable tickets. Signed payments themselves are never returned.
    autopay,
  });
}

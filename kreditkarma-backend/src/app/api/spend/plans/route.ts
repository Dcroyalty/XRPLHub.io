// src/app/api/spend/plans/route.ts
// POST /api/spend/plans — create a Spend Controls plan. FREE (no fee, no prepay): active as soon as it is created.
//   body: { funder, name?, period: "weekly"|"monthly", checkSize: "10", payees: [{ address, label, category, budget, destinationTag? }] }
//   SUBSCRIPTION: { kind: "subscription", currency: "RLUSD"|"XRP", funder, name?, period, payees: [ONE { address, label, category,
//   budget = the amount per period, destinationTag? }] } — one check per period, created only when that period starts.
//   ?dryRun=1 — validate + preview only (nothing saved): the check split, the XRP reserve that locks up front, the
//   funder's RLUSD balance against the period's total. The create form calls this on every change.
// Stores the plan only — never funds, never keys. See src/lib/spendControls.ts.

import { prisma } from "@/lib/xrplscore-db";
import { rateLimit, rateLimited } from "@/lib/rateLimit";
import { checkPayeeAccount, fromCents, funderBalance, newShareToken, ownerReserveXrp, validatePlanInput, type PlanInput } from "@/lib/spendControls";
import { SPEND_DISCLOSURE, spendErr, spendJson } from "@/lib/spendApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

export async function POST(req: Request) {
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const rl = rateLimit(req, dryRun ? "spend-preview" : "spend-create", dryRun ? 40 : 6, 60_000);
  if (!rl.ok) return rateLimited(rl);
  const body = (await req.json().catch(() => null)) as PlanInput | null;
  if (!body) return spendErr(400, "bad_request", "Send the plan as JSON.");

  const v = validatePlanInput(body);
  if (!v.ok) return spendErr(422, "invalid_plan", v.error, { field: v.field });

  // Ledger checks: the funder exists, every payee can receive a check, and how much RLUSD the funder holds.
  const [reserve, balance, payeeChecks] = await Promise.all([
    ownerReserveXrp(),
    funderBalance(v.funder, v.currency),
    Promise.all(v.payees.map((p) => checkPayeeAccount(p.address, p.destinationTag ?? null))),
  ]);
  const payeeProblems = payeeChecks.map((c, n) => (c.ok ? null : { payee: n, label: v.payees[n].label, error: c.error, needsTag: !!c.needsTag })).filter(Boolean);

  const preview = {
    kind: v.kind,
    period: v.period,
    checkSize: fromCents(v.checkSizeCents),
    currency: v.currency,
    payees: v.payees.map((p) => ({ label: p.label, category: p.category, budget: p.budget, checks: p.checks.map(fromCents) })),
    checksPerPeriod: v.totalChecks,
    totalPerPeriod: fromCents(v.totalBudgetCents),
    reserve: {
      perCheckXrp: reserve,
      upFrontXrp: Number((reserve * v.totalChecks).toFixed(6)),
      note: `${v.totalChecks} open check${v.totalChecks === 1 ? " holds" : "s hold"} ${Number((reserve * v.totalChecks).toFixed(6))} XRP of your reserve while open. It comes back as each check is cashed or cancelled.`,
    },
    funderBalance: balance,
    funderRlusd: v.currency === "RLUSD" ? balance : null,
    funded: balance === null ? null : balance >= v.totalBudgetCents / 100,
    fundingNote: balance === null ? `Could not read your ${v.currency} balance just now.` : balance >= v.totalBudgetCents / 100
      ? `Your wallet holds enough ${v.currency} for this period's checks.`
      : `Your wallet holds ${balance} ${v.currency}${v.currency === "XRP" ? " (above reserve)" : ""} but this period's checks total ${fromCents(v.totalBudgetCents)}. Checks don't lock funds — a check can only be cashed while the money is in your wallet.`,
    price: { free: true, note: "Spend Controls is free: no plan fee, no prepay. Merchants cash free. Your wallet pays only the XRP Ledger's network fee." },
    ...(v.kind === "subscription" ? { subscription: {
      amountPerPeriod: fromCents(v.totalBudgetCents),
      how: "One check per period, created only when that period starts (never ahead — a check can be cashed as soon as it exists). Sign it in Xaman; after your first signature we push each new period's check to your Xaman app. Unsigned = unpaid. Cancel any time: unsigned checks are never created, and an open one can be cancelled until it is cashed.",
    } } : {}),
    payeeProblems,
    disclosure: SPEND_DISCLOSURE,
  };
  if (dryRun) return spendJson({ ok: payeeProblems.length === 0, preview });
  if (payeeProblems.length) return spendErr(422, "payee_problem", "Fix the payees below before creating the plan.", { preview });

  const plan = await prisma.spendPlan.create({
    data: {
      funder: v.funder, name: v.name, period: v.period, kind: v.kind, currency: v.currency, status: "active", checkSize: fromCents(v.checkSizeCents), shareToken: newShareToken(),
      payees: { create: v.payees.map((p, position) => ({ address: p.address, label: p.label, category: p.category, budget: p.budget, destinationTag: p.destinationTag ?? null, position })) },
    },
  });
  return spendJson({ id: plan.id, status: plan.status, dashboard: `/spend/plan/${plan.id}`, shareLink: `/spend/s/${plan.shareToken}`, preview }, 201);
}

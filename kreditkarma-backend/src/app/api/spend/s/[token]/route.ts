// src/app/api/spend/s/[token]/route.ts
// GET /api/spend/s/:token — the BENEFICIARY view of a plan: where they can spend and how much is available right now
// ("Joe's Market, up to $50, expires Oct 12"). No account, no keys, no funds — read-only, from the ledger-synced checks.
// Shows only payee labels, categories, check amounts and expiries, plus a link a merchant opens to cash each check.

import { prisma } from "@/lib/xrplscore-db";
import { rateLimit, rateLimited } from "@/lib/rateLimit";
import { fromRipple, rlusdBalance, syncPlanChecks } from "@/lib/spendControls";
import { SPEND_DISCLOSURE, spendErr, spendJson } from "@/lib/spendApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const rl = rateLimit(req, "spend-share", 30, 60_000);
  if (!rl.ok) return rateLimited(rl);
  const { token } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{16,40}$/.test(token)) return spendErr(404, "not_found", "This link isn't valid.");
  const plan = await prisma.spendPlan.findUnique({ where: { shareToken: token }, include: { payees: { orderBy: { position: "asc" } } } });
  if (!plan) return spendErr(404, "not_found", "This link isn't valid.");

  await syncPlanChecks(prisma, plan.id, plan.funder);
  const open = await prisma.spendCheck.findMany({ where: { planId: plan.id, status: "open" }, include: { payee: true }, orderBy: [{ payee: { position: "asc" } }, { seq: "asc" }] });
  const balance = await rlusdBalance(plan.funder);
  const totalOpen = open.reduce((a, c) => a + Number(c.amount), 0);

  return spendJson({
    plan: plan.name ?? "Spending plan",
    currency: plan.currency,
    places: plan.payees.map((p) => {
      const checks = open.filter((c) => c.payeeId === p.id);
      return {
        label: p.label, category: p.category,
        availableNow: checks.reduce((a, c) => a + Number(c.amount), 0).toFixed(2),
        checks: checks.map((c) => ({ amount: c.amount, expires: fromRipple(c.expiration).toISOString(), cashLink: c.checkId ? `/spend/cash/${c.checkId}` : null })),
      };
    }),
    // Checks don't lock funds: say plainly when the funder's wallet couldn't cover them all right now.
    fundsWarning: balance !== null && balance + 1e-9 < totalOpen
      ? `The funder's wallet currently holds less than these checks add up to (${balance} of ${totalOpen.toFixed(2)} RLUSD). A check can only be cashed while the money is there.`
      : null,
    howToSpend: "Show the merchant the check you want to use. They open its link and cash it with their own XRPL wallet — free. One check pays once, so a check can't be split across two purchases.",
    disclosure: SPEND_DISCLOSURE,
  });
}

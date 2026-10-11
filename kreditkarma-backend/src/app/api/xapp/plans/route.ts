// src/app/api/xapp/plans/route.ts
// GET (Authorization: Bearer <xApp session>) — the Spend Controls plans this account funds that are still running (an
// ended plan never shows), newest first, with this
// period's check counts from the database (each plan's own dashboard, GET /api/spend/plans/:id, syncs the ledger).
// Only the account Xaman confirmed (POST /api/xapp/session) can list its plans.

import { prisma } from "@/lib/xrplscore-db";
import { rateLimit, rateLimited } from "@/lib/rateLimit";
import { sessionFromRequest } from "@/lib/xappSession";
import { periodWindow, type Period } from "@/lib/spendControls";
import { spendErr, spendJson } from "@/lib/spendApi";
import { autopayCovers } from "@/lib/spendAutopay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const rl = rateLimit(req, "xapp-plans", 60, 60_000);
  if (!rl.ok) return rateLimited(rl);
  const account = sessionFromRequest(req);
  if (!account) return spendErr(401, "no_session", "Your xApp session expired. Close and reopen the xApp.");

  const plans = await prisma.spendPlan.findMany({
    where: { funder: account, status: "active" },
    include: { payees: { orderBy: { position: "asc" } } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const out = [];
  for (const p of plans) {
    const { start, end } = periodWindow(p.period as Period);
    const rows = await prisma.spendCheck.findMany({ where: { planId: p.id, periodStart: start }, select: { status: true } });
    // A failed Autopay payment must be visible here even when Xaman can no longer push to this payer (token expired).
    const ap = p.kind === "subscription" && p.autopayStatus !== "off" ? await autopayCovers(prisma, p.id, { start, end }).catch(() => null) : null;
    out.push({
      id: p.id, name: p.name, kind: p.kind, period: p.period, currency: p.currency, checkSize: p.checkSize,
      payees: p.payees.map((x) => x.label),
      thisPeriod: { checks: rows.length, unsigned: rows.filter((r) => r.status === "unsigned").length, open: rows.filter((r) => r.status === "open").length },
      pushReady: !!p.xamanUserToken,
      autopay: ap?.covered ? "covered" : ap?.failedReason ? "failed" : null,
      autopayFailedReason: ap?.failedReason ?? null,
    });
  }
  return spendJson({ account, plans: out });
}

// src/app/api/spend/plans/[id]/end/route.ts
// POST -> end this plan (the payer's choice). No more checks or Xaman requests for it, every Autopay payment not yet sent
// is cancelled, and it leaves the xApp's plan list. Open checks stay cashable until cancelled on the dashboard, and
// Autopay tickets stay until released there. Can't be undone (make a new plan instead). The plan id is the dashboard's
// secret, as for every other Spend Controls action.

import { prisma } from "@/lib/xrplscore-db";
import { rateLimit, rateLimited } from "@/lib/rateLimit";
import { loadPlan, spendErr, spendJson } from "@/lib/spendApi";
import { endPlan } from "@/lib/spendAutopay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const rl = rateLimit(req, "spend-end", 10, 60_000);
  if (!rl.ok) return rateLimited(rl);
  const { id } = await ctx.params;
  const plan = await loadPlan(id);
  if (!plan) return spendErr(404, "not_found", "No plan with that id.");
  const r = await endPlan(prisma, plan);
  return spendJson({ ended: true, already: r.already, cancelledAutopay: r.cancelledAutopay });
}

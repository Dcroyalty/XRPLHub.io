// src/app/api/spend/plans/[id]/cancel/route.ts
// POST { checkId } -> an unsigned CheckCancel for one of THIS plan's open or expired checks, signed by the funder.
// Cancelling returns the check's 0.2 XRP reserve. Free (part of the plan).

import { prisma } from "@/lib/xrplscore-db";
import { rateLimit, rateLimited } from "@/lib/rateLimit";
import { buildCheckCancel, normalizeCheckId } from "@/lib/checks";
import { loadPlan, signRequest, spendErr, spendJson } from "@/lib/spendApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const rl = rateLimit(req, "spend-cancel", 30, 60_000);
  if (!rl.ok) return rateLimited(rl);
  const { id } = await ctx.params;
  const plan = await loadPlan(id);
  if (!plan) return spendErr(404, "not_found", "No plan with that id.");
  const body = (await req.json().catch(() => ({}))) as { checkId?: unknown };
  const checkId = normalizeCheckId(body.checkId);
  if (!checkId) return spendErr(400, "bad_request", "A check ID is 64 hexadecimal characters.");
  const row = await prisma.spendCheck.findFirst({ where: { planId: plan.id, checkId }, include: { payee: true } });
  if (!row) return spendErr(404, "not_found", "That check doesn't belong to this plan.");
  if (row.status !== "open" && row.status !== "expired") return spendErr(409, "not_open", `That check is ${row.status}${row.closedHow ? ` (${row.closedHow})` : ""}.`);
  const b = buildCheckCancel({ account: plan.funder, checkId });
  if (!b.ok) return spendErr(400, "build_failed", b.error);
  const xaman = await signRequest(b.txjson, `cancel the check to ${row.payee.label} (${row.amount} ${plan.currency})`, plan.id);
  return spendJson({ checkId, txjson: b.txjson, ...(xaman ?? { uuid: null, qr_png: null, deep_link: null }) });
}

// src/app/api/spend/plans/[id]/sign/route.ts
// POST { invoiceId }  -> one unsigned RLUSD CheckCreate for this period + a Xaman request (the funder signs; one per check).
// POST { batch: true } -> up to 8 of this period's unsigned checks in ONE single-account Batch signature — only when
//                         BatchV1_1 is active on mainnet AND Xaman signing was verified (batchAvailability()).
// Free. XRPLHub never signs.

import { prisma } from "@/lib/xrplscore-db";
import { rateLimit, rateLimited } from "@/lib/rateLimit";
import { BATCH_MAX_INNER, batchAvailability, buildChecksBatch, checkCreateFor, ensurePeriodChecks } from "@/lib/spendControls";
import { loadPlan, signRequest, spendErr, spendJson } from "@/lib/spendApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const rl = rateLimit(req, "spend-sign", 60, 60_000);
  if (!rl.ok) return rateLimited(rl);
  const { id } = await ctx.params;
  const plan = await loadPlan(id);
  if (!plan) return spendErr(404, "not_found", "No plan with that id.");
  const body = (await req.json().catch(() => ({}))) as { invoiceId?: unknown; batch?: unknown };

  const rows = (await ensurePeriodChecks(prisma, plan)).filter((r) => r.status === "unsigned");

  if (body.batch === true) {
    const avail = await batchAvailability();
    if (!avail.available) return spendErr(409, "batch_unavailable", `One-signature batches aren't available yet: ${avail.reason}. Sign each check instead.`);
    const pick = rows.slice(0, BATCH_MAX_INNER);
    if (!pick.length) return spendErr(409, "nothing_to_sign", "Every check for this period is already created.");
    const inner = [];
    for (const r of pick) {
      const b = checkCreateFor(plan.funder, r, plan.currency);
      if (!b.ok) return spendErr(400, "build_failed", `${r.payee.label} #${r.seq}: ${b.error}`);
      inner.push(b.txjson);
    }
    const batch = await buildChecksBatch(plan.funder, inner);
    if (!batch.ok) return spendErr(503, "build_failed", batch.error);
    const xaman = await signRequest(batch.txjson, `create ${inner.length} checks in one signature`, plan.id);
    return spendJson({ mode: "batch", count: inner.length, invoiceIds: pick.map((r) => r.invoiceId), txjson: batch.txjson, ...(xaman ?? { uuid: null, qr_png: null, deep_link: null }), note: "Sign before sending any other transaction from this account — the batch is tied to your next sequence numbers." });
  }

  const invoiceId = String(body.invoiceId ?? "").toUpperCase();
  const row = rows.find((r) => r.invoiceId === invoiceId);
  if (!row) return spendErr(404, "not_found", "That check isn't an unsigned check of this period (it may already be created — refresh the dashboard).");
  const b = checkCreateFor(plan.funder, row, plan.currency);
  if (!b.ok) return spendErr(400, "build_failed", b.error);
  const xaman = await signRequest(b.txjson, `check to ${row.payee.label}, up to ${row.amount} ${plan.currency}`, plan.id);
  return spendJson({ mode: "single", invoiceId: row.invoiceId, txjson: b.txjson, ...(xaman ?? { uuid: null, qr_png: null, deep_link: null }) });
}

// src/app/api/spend/plans/[id]/pay/route.ts
// Prepay a Spend Controls plan: $5/month in RLUSD, 1–12 months, from the FUNDER's own account (which is what ties the
// plan to that account). Verified on the ledger; each payment hash counts once (and never also as a storefront purchase).
//
//   POST { months }              -> the RLUSD Payment to sign (Xaman request + the txjson for any wallet)
//   POST { months, txHash }      -> verify that payment and extend the plan
//   POST { months, uuid }        -> same, reading the hash from the signed Xaman request

import { prisma } from "@/lib/xrplscore-db";
import { rateLimit, rateLimited } from "@/lib/rateLimit";
import { getPayloadStatus } from "@/lib/xumm";
import { RLUSD_HEX, RLUSD_ISSUER, TREASURY } from "@/lib/pricing";
import { MAX_PREPAY_MONTHS, applyPlanPayment, planPriceRlusd } from "@/lib/spendControls";
import { loadPlan, signRequest, spendErr, spendJson } from "@/lib/spendApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const rl = rateLimit(req, "spend-pay", 20, 60_000);
  if (!rl.ok) return rateLimited(rl);
  const { id } = await ctx.params;
  const plan = await loadPlan(id);
  if (!plan) return spendErr(404, "not_found", "No plan with that id.");
  const body = (await req.json().catch(() => ({}))) as { months?: unknown; txHash?: unknown; uuid?: unknown };
  const months = Number(body.months ?? 1);
  if (!Number.isInteger(months) || months < 1 || months > MAX_PREPAY_MONTHS) return spendErr(400, "bad_request", `months must be 1–${MAX_PREPAY_MONTHS}`);

  let txHash = typeof body.txHash === "string" ? body.txHash.trim() : "";
  if (!txHash && typeof body.uuid === "string" && body.uuid) {
    const st = await getPayloadStatus(body.uuid).catch(() => null);
    if (!st || st.state === "pending") return spendJson({ status: "pending" }, 202);
    if (st.state !== "signed" || !st.txid) return spendErr(409, st.state, `The payment request was ${st.state}.`);
    txHash = st.txid;
  }

  if (txHash) {
    const r = await applyPlanPayment(prisma, plan, txHash, months);
    if (!r.ok) return spendErr(r.retry ? 202 : 402, r.retry ? "pending" : "payment_rejected", r.error, r.retry ? { retry: true } : {});
    return spendJson({ status: "paid", paidThrough: r.paidThrough, dashboard: `/spend/plan/${plan.id}` });
  }

  const amount = planPriceRlusd(months);
  const txjson = { TransactionType: "Payment", Account: plan.funder, Destination: TREASURY, Amount: { currency: RLUSD_HEX, issuer: RLUSD_ISSUER, value: String(amount) } };
  const xaman = await signRequest(txjson, `prepay plan ${months} month${months === 1 ? "" : "s"} (${amount} RLUSD)`, plan.id);
  return spendJson({ months, amount: String(amount), currency: "RLUSD", payTo: TREASURY, txjson, ...(xaman ?? { uuid: null, qr_png: null, deep_link: null }), note: "Pay from the funder's own account. After it validates, POST the same months with txHash (or uuid)." });
}

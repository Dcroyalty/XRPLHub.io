// src/app/api/spend/plans/[id]/signed/route.ts
// POST { uuid } — called by the dashboard / xApp right after the funder signs a Spend Controls request in Xaman.
// We read that payload from Xaman ONCE and, only if it is OUR Spend payload (identifier xrplhub_spend_*) signed by THIS
// plan's funder, keep the push token Xaman issued (application.issued_user_token). The daily job uses it to push the
// next period's subscription check to the funder's app. The token is never returned by any API.
// Nothing moves money here; the ledger stays the truth for check state (GET /api/spend/plans/:id syncs it).

import { prisma } from "@/lib/xrplscore-db";
import { rateLimit, rateLimited } from "@/lib/rateLimit";
import { getPayloadStatus, xummConfigured } from "@/lib/xumm";
import { loadPlan, spendErr, spendJson } from "@/lib/spendApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const rl = rateLimit(req, "spend-signed", 20, 60_000);
  if (!rl.ok) return rateLimited(rl);
  const { id } = await ctx.params;
  const plan = await loadPlan(id);
  if (!plan) return spendErr(404, "not_found", "No plan with that id.");
  const body = (await req.json().catch(() => ({}))) as { uuid?: unknown };
  const uuid = String(body.uuid ?? "");
  if (!UUID_RE.test(uuid)) return spendErr(400, "bad_request", "Send the Xaman payload uuid.");
  if (!xummConfigured()) return spendJson({ pushReady: !!plan.xamanUserToken, note: "Xaman is not configured." });

  const st = await getPayloadStatus(uuid).catch(() => null);
  if (!st) return spendErr(502, "xaman_unreachable", "Could not read that sign request from Xaman just now.");
  if (st.state !== "signed") return spendJson({ pushReady: !!plan.xamanUserToken, state: st.state });
  if (!st.identifier?.startsWith("xrplhub_spend_")) return spendErr(403, "not_ours", "That is not a Spend Controls sign request.");
  if (st.signer !== plan.funder) return spendErr(403, "wrong_signer", "That request was signed by a different account than this plan's funder.");

  if (st.userToken && st.userToken !== plan.xamanUserToken) {
    await prisma.spendPlan.update({ where: { id: plan.id }, data: { xamanUserToken: st.userToken } });
  }
  return spendJson({ pushReady: !!(st.userToken ?? plan.xamanUserToken), txid: st.txid });
}

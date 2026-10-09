// src/app/api/spend/plans/[id]/autopay/route.ts
// Spend Controls AUTOPAY (subscriptions). Free. XRPLHub never signs; the payer signs every step in their own wallet.
//   GET                                   → the Autopay view (status, schedule, releasable tickets, disclosure)
//   POST { action: "start", periods }     → preflight + ONE TicketCreate sign request (Xaman submits it)
//   POST { action: "tickets" }            → after that signature: read the tickets, make one payment per future period
//   POST { action: "sign" }               → a sign-only (submit:false) request for the next payment to pre-approve
//   POST { action: "signed", uuid }       → store that approved payment (checked, encrypted; never returned)
//   POST { action: "cancel" }             → stop at once; nothing unsent will ever be sent by us
//   POST { action: "release", tickets }   → a request that uses up tickets, so those payments can never be sent by anyone
// The plan id is the dashboard's secret, as for every other Spend Controls action.

import { prisma } from "@/lib/xrplscore-db";
import { rateLimit, rateLimited } from "@/lib/rateLimit";
import { loadPlan, spendErr, spendJson } from "@/lib/spendApi";
import { acceptSigned, autopayView, cancelAutopay, confirmTickets, nextSignRequest, releaseRequest, startAutopay, type Fail } from "@/lib/spendAutopay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 25;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const rl = rateLimit(req, "spend-autopay-get", 30, 60_000);
  if (!rl.ok) return rateLimited(rl);
  const { id } = await ctx.params;
  const plan = await loadPlan(id);
  if (!plan) return spendErr(404, "not_found", "No plan with that id.");
  return spendJson(await autopayView(prisma, plan));
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const rl = rateLimit(req, "spend-autopay", 40, 60_000);
  if (!rl.ok) return rateLimited(rl);
  const { id } = await ctx.params;
  const plan = await loadPlan(id);
  if (!plan) return spendErr(404, "not_found", "No plan with that id.");
  if (plan.kind !== "subscription") return spendErr(409, "not_subscription", "Autopay is only for recurring payments.");
  const body = (await req.json().catch(() => ({}))) as { action?: unknown; periods?: unknown; uuid?: unknown; tickets?: unknown };

  let r: { ok: true } & Record<string, unknown> | Fail;
  switch (body.action) {
    case "start": r = await startAutopay(prisma, plan, body.periods); break;
    case "tickets": r = await confirmTickets(prisma, plan); break;
    case "sign": r = await nextSignRequest(prisma, plan); break;
    case "signed": {
      const uuid = String(body.uuid ?? "");
      if (!UUID_RE.test(uuid)) return spendErr(400, "bad_request", "Send the Xaman request uuid.");
      r = await acceptSigned(prisma, plan, uuid); break;
    }
    case "cancel": r = await cancelAutopay(prisma, plan); break;
    case "release": r = await releaseRequest(prisma, plan, body.tickets); break;
    default: return spendErr(400, "bad_request", "action must be start, tickets, sign, signed, cancel or release.");
  }
  if (!r.ok) return spendErr(r.status, r.error, r.message);
  const { ok: _ok, ...rest } = r;
  return spendJson(rest);
}

// src/app/api/xapp/session/route.ts
// POST { ott } — the Spend Controls xApp opens with ?xAppToken=<one-time token>. We resolve it SERVER-SIDE with our Xaman
// API key + secret (the page can't fake the account), then:
//   - return a 12-hour session naming the account (src/lib/xappSession.ts);
//   - keep Xaman's user token on this account's subscription plans, so each new period's check can be pushed to them.
// Mainnet only: Spend Controls checks are mainnet RLUSD / XRP.

import { prisma } from "@/lib/xrplscore-db";
import { rateLimit, rateLimited } from "@/lib/rateLimit";
import { getXappOtt, xummConfigured } from "@/lib/xumm";
import { issueXappSession } from "@/lib/xappSession";
import { isValidXrplAddress } from "@/lib/address";
import { spendErr, spendJson } from "@/lib/spendApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function POST(req: Request) {
  const rl = rateLimit(req, "xapp-session", 20, 60_000);
  if (!rl.ok) return rateLimited(rl);
  if (!xummConfigured()) return spendErr(503, "not_configured", "Xaman is not configured on this server.");
  const body = (await req.json().catch(() => ({}))) as { ott?: unknown };
  const ott = String(body.ott ?? "");
  if (!/^[0-9a-f-]{20,64}$/i.test(ott)) return spendErr(400, "bad_request", "Open this inside Xaman: the xAppToken is missing.");

  const o = await getXappOtt(ott).catch(() => null);
  if (!o || !o.account || !isValidXrplAddress(o.account)) {
    return spendErr(401, "ott_invalid", "Xaman didn't confirm this session (the token may have been used already). Close and reopen the xApp.");
  }
  if (o.nodetype && o.nodetype !== "MAINNET") {
    return spendErr(409, "wrong_network", `Spend Controls runs on the XRP Ledger mainnet; Xaman is on ${o.nodetype}. Switch network in Xaman and reopen.`);
  }
  const session = issueXappSession(o.account);
  if (!session) return spendErr(503, "not_configured", "Sessions are not configured on this server.");

  if (o.userToken) {
    await prisma.spendPlan.updateMany({ where: { funder: o.account, kind: "subscription" }, data: { xamanUserToken: o.userToken } });
  }
  return spendJson({ session, account: o.account, canSign: o.accountaccess !== "READONLY" });
}

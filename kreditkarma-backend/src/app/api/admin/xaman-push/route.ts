// src/app/api/admin/xaman-push/route.ts — admin-only: what did Xaman actually do with a sign request, and can we push?
//   GET  ?uuids=a,b&planId=…  → for each Xaman request: Xaman's own record (meta.pushed, app_opened, expired, signed…),
//                               which Xaman app created it, whether it issued a push token and whether that token is
//                               still active; plus whether the plan's stored token is active. Token values never leave.
//   POST { action: "signin" } → a SignIn request shown as QR / link (NOT pushed): signing it should make Xaman issue a fresh
//                               user token (application.issued_user_token) — then GET it to see whether one was issued.
//   POST { tokenFrom }        → push ONE test request (a SignIn: nothing to sign or submit; the owner taps Decline) using
//                               the token issued by a request the admin's own wallet signed. Returns Xaman's `pushed`.
// Fields per https://docs.xaman.dev (payload GET: meta.pushed / application.issued_user_token; POST: "pushed": true).

import { prisma } from "@/lib/xrplscore-db";
import { adminSessionWallet, adminUnauthorized, isAdmin } from "@/lib/adminAuth";
import { createPayload, getPayloadRaw, userTokensActive, xummConfigured } from "@/lib/xumm";
import { TREASURY } from "@/lib/pricing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (b: unknown, status = 200) => Response.json(b, { status, headers: { "Cache-Control": "no-store" } });
const day = (t?: number) => (t ? new Date(t * 1000).toISOString() : null);

async function describe(uuid: string) {
  const d = await getPayloadRaw(uuid);
  if (!d) return { uuid, error: "Xaman returned nothing for this uuid" };
  if (d.error) return { uuid, xamanError: d.error };
  const meta = (d.meta ?? {}) as Record<string, unknown>;
  const app = (d.application ?? {}) as Record<string, unknown>;
  const p = (d.payload ?? {}) as Record<string, unknown>;
  const r = (d.response ?? {}) as Record<string, unknown>;
  const cm = (d.custom_meta ?? {}) as Record<string, unknown>;
  const token = typeof app.issued_user_token === "string" ? app.issued_user_token : null;
  return {
    uuid,
    txType: p.tx_type ?? null, createdAt: p.created_at ?? null, expiresAt: p.expires_at ?? null,
    identifier: cm.identifier ?? null, instruction: cm.instruction ?? null,
    xamanApp: { name: app.name ?? null, uuid: app.uuidv4 ?? null, disabled: app.disabled ?? null },
    meta: { exists: meta.exists, pushed: meta.pushed, app_opened: meta.app_opened, opened_by_deeplink: meta.opened_by_deeplink, signed: meta.signed, cancelled: meta.cancelled, expired: meta.expired, resolved: meta.resolved, is_xapp: meta.is_xapp },
    signer: r.account ?? null, resolvedAt: r.resolved_at ?? null,
    issuedToken: token ? { present: true, ref: token.slice(0, 4) + "…" } : { present: false },
    _token: token,
  };
}

export async function GET(req: Request) {
  if (!isAdmin(req)) return adminUnauthorized();
  if (!xummConfigured()) return json({ error: "Xaman not configured" }, 503);
  const url = new URL(req.url);
  const uuids = (url.searchParams.get("uuids") ?? "").split(",").map((s) => s.trim()).filter((s) => UUID_RE.test(s)).slice(0, 8);
  const planId = url.searchParams.get("planId");
  const rows = await Promise.all(uuids.map(describe));
  const plan = planId && /^[a-z0-9]{20,40}$/i.test(planId) ? await prisma.spendPlan.findUnique({ where: { id: planId }, select: { id: true, xamanUserToken: true } }) : null;
  const tokens = [...new Set([...rows.map((r) => ("_token" in r ? r._token : null)), plan?.xamanUserToken ?? null].filter((t): t is string => !!t))];
  const v = await userTokensActive(tokens);
  const state = (t: string | null) => (!t ? null : v ? (v.get(t) ? { active: v.get(t)!.active, expires: v.get(t)!.expires?.toISOString() ?? null } : { active: null, note: "Xaman did not list this token" }) : { active: null, note: "could not ask Xaman" });
  return json({
    requests: rows.map((r) => {
      if (!("_token" in r)) return r;
      const { _token, ...rest } = r;
      return { ...rest, issuedToken: { ...rest.issuedToken, ...(_token ? { state: state(_token), sameAsPlanToken: plan?.xamanUserToken ? _token === plan.xamanUserToken : null } : {}) } };
    }),
    plan: plan ? { id: plan.id, hasToken: !!plan.xamanUserToken, tokenRef: plan.xamanUserToken ? plan.xamanUserToken.slice(0, 4) + "…" : null, tokenState: state(plan.xamanUserToken) } : null,
    checkedAt: new Date().toISOString(),
  });
}

export async function POST(req: Request) {
  if (!isAdmin(req)) return adminUnauthorized();
  if (!xummConfigured()) return json({ error: "Xaman not configured" }, 503);
  const body = (await req.json().catch(() => ({}))) as { tokenFrom?: unknown; action?: unknown };
  if (body.action === "signin") {
    const s = await createPayload({ txjson: { TransactionType: "SignIn" }, submit: false, expireMinutes: 10, identifier: `xrplhub_tokentest_${Date.now()}`, instruction: "XRPLHub push test, step 1: sign in so Xaman issues a push token. Nothing is sent." });
    return json({ uuid: s.uuid, qr_png: s.qrPng, deep_link: s.deepLink });
  }
  const from = String(body.tokenFrom ?? "");
  if (!UUID_RE.test(from)) return json({ error: "tokenFrom must be a Xaman request uuid" }, 400);
  const src = await describe(from);
  if (!("_token" in src) || !src._token) return json({ error: "That request issued no push token (it must be one the user signed)", source: src }, 409);
  // Only push to the owner: the token must come from a request signed by the admin's own wallet (or the treasury).
  const allowed = new Set([TREASURY, adminSessionWallet(req)].filter(Boolean));
  if (!allowed.has(String(src.signer))) return json({ error: `That request was signed by ${src.signer}, not by the admin wallet` }, 403);
  const p = await createPayload({
    txjson: { TransactionType: "SignIn" }, submit: false, expireMinutes: 10, userToken: src._token,
    identifier: `xrplhub_pushtest_${Date.now()}`,
    instruction: "XRPLHub reminder test. Nothing to sign or send. Please tap Decline.",
  });
  return json({ uuid: p.uuid, pushed: p.pushed === true, tokenFrom: from, tokenRef: src._token.slice(0, 4) + "…", sentAt: new Date().toISOString() });
}

// src/app/api/delegate/route.ts
// Permission Delegation (XLS-75) — the FREE half of the service: see who you've delegated to, and revoke.
//
//   GET  /api/delegate?account=r...   -> live availability + every delegation this account has granted, each
//                                        permission labelled with what it allows (public ledger data; read-only).
//   POST /api/delegate {account, delegate}
//                                     -> the revoke: a DelegateSet with an empty Permissions list (deletes the grant),
//                                        plus a Xaman sign request. Only built when that delegation actually exists on
//                                        the ledger, so this can never act as a free general-purpose builder.
//
// Revoking is free on purpose: taking away someone's power over your account must never wait on a payment.
// Granting is the paid storefront service (`delegate`, src/app/api/execute/serviceBuilders.ts).
// Amendment-gated like the paid service (src/lib/serviceAmendments.ts) — fail closed.

import { NextResponse } from "next/server";
import { isValidXrplAddress } from "@/lib/address";
import { buildDelegateRevoke, grantedPermissions, permissionInfo } from "@/lib/delegation";
import { getDelegate, listDelegates } from "@/lib/serviceChain";
import { serviceAvailability } from "@/lib/serviceAmendments";
import { createPayload, safeIdentifier, xummConfigured } from "@/lib/xumm";
import { rateLimit, rateLimited } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const bad = (status: number, error: string, message: string) => NextResponse.json({ error, message }, { status });

export async function GET(req: Request) {
  const rl = rateLimit(req, "delegate-list", 30, 60_000);
  if (!rl.ok) return rateLimited(rl);
  const account = (new URL(req.url).searchParams.get("account") ?? "").trim();
  const availability = await serviceAvailability("delegate");
  if (!account) return NextResponse.json({ availability }, { headers: { "Cache-Control": "no-store" } });
  if (!isValidXrplAddress(account)) return bad(400, "bad_request", "Provide a valid XRPL address (?account=r...).");

  const objs = availability.available ? await listDelegates(account) : [];
  if (objs === null) return bad(503, "ledger_unavailable", "Could not read your delegations from the XRP Ledger just now — try again in a moment.");
  const delegations = objs.map((o) => ({
    delegate: String(o.Authorize),
    permissions: grantedPermissions(o).map((v) => {
      const info = permissionInfo(v);
      return { value: v, label: info?.label ?? v, risk: info?.risk ?? "spend", allows: info?.allows ?? "A permission this page does not describe — treat it as able to move your funds." };
    }),
  }));
  return NextResponse.json({ account, availability, delegations }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const rl = rateLimit(req, "delegate-revoke", 10, 60_000);
  if (!rl.ok) return rateLimited(rl);
  const body = (await req.json().catch(() => ({}))) as { account?: unknown; delegate?: unknown };
  const account = String(body.account ?? "").trim();
  const delegate = String(body.delegate ?? "").trim();
  if (!isValidXrplAddress(account) || !isValidXrplAddress(delegate)) {
    return bad(400, "bad_request", "Provide your account and the delegate's account (both valid r-addresses).");
  }

  const availability = await serviceAvailability("delegate");
  if (!availability.available) return bad(409, "not_available", availability.message ?? "Permission delegation is not available yet.");

  const existing = await getDelegate(account, delegate);
  if (existing === null) return bad(503, "ledger_unavailable", "Could not read the XRP Ledger just now — try again in a moment.");
  if (existing === false) return bad(404, "nothing_to_revoke", `${delegate} holds no permissions from ${account}, so there is nothing to revoke.`);

  const built = buildDelegateRevoke(account, delegate);
  if (!built.ok) return bad(400, "bad_request", built.error);

  let xaman: { uuid: string; qr_png: string | null; deep_link: string | null } | null = null;
  if (xummConfigured()) {
    try {
      const p = await createPayload({
        txjson: built.txjson,
        identifier: safeIdentifier("xrplhub_revoke_", delegate.slice(0, 12), `_${Date.now()}`),
        instruction: `XRPLHub — revoke every permission ${delegate.slice(0, 8)}… holds on your account. Free.`,
      });
      xaman = { uuid: p.uuid, qr_png: p.qrPng, deep_link: p.deepLink };
    } catch {
      // Xaman down: the txjson below still works in any wallet (Crossmark / GemWallet / manual).
    }
  }
  return NextResponse.json({
    free: true,
    revokes: grantedPermissions(existing),
    txjson: built.txjson,
    uuid: xaman?.uuid ?? null,
    qr_png: xaman?.qr_png ?? null,
    deep_link: xaman?.deep_link ?? null,
    instructions: "Sign this with your own wallet. Once it validates, the delegate can no longer sign anything for your account, and the 0.2 XRP reserve is returned.",
  });
}

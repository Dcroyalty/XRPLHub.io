// src/app/api/admin/delegation-test/route.ts
// TEMPORARY (2026-10-09) — admin-only. Creates ONE Xaman request for the owner's revoke test of the Wallet Permissions
// Check: the treasury grants rmWjCGeL… a single harmless permission, AccountEmailHashSet (it can only change the
// treasury's unused EmailHash field — no money, no keys, no Domain). Nothing else can be built here.
// The revoke runs through the real product (POST /api/permissions/fix). Remove this route when the test is done.

import { isAdmin } from "@/lib/adminAuth";
import { createPayload } from "@/lib/xumm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TREASURY = "rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF";
const DELEGATE = "rmWjCGeLtuLGerEuvHDkrsr46ej2Ni13f";

export async function POST(req: Request) {
  if (!isAdmin(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const txjson = { TransactionType: "DelegateSet", Account: TREASURY, Authorize: DELEGATE, Permissions: [{ Permission: { PermissionValue: "AccountEmailHashSet" } }] };
  const p = await createPayload({
    txjson,
    expireMinutes: 60,
    identifier: `xrplhub_perm_granttest_${Date.now()}`,
    instruction: "XRPLHub TEST — grant rmWjCGeL… ONE harmless permission (AccountEmailHashSet: change the unused EmailHash field). Holds 0.2 XRP until revoked.",
  });
  return Response.json({ uuid: p.uuid, deep_link: p.deepLink, qr_png: p.qrPng, txjson });
}

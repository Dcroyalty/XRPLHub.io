// src/app/api/admin/delegation-test/route.ts
// TEMPORARY (2026-10-09) — admin-only. Creates ONE Xaman request for the owner's revoke test of the Wallet Permissions
// Check: the treasury grants rmWjCGeL… a single harmless permission, AccountEmailHashSet (it can only change the
// treasury's unused EmailHash field — no money, no keys, no Domain). Nothing else can be built here.
// The first attempt was refused by Xaman, so this returns Xaman's full answer and tries the permission by name and by
// its numeric value. Remove this route when the test is done.

import { isAdmin } from "@/lib/adminAuth";
import { xummFetch } from "@/lib/xumm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TREASURY = "rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF";
const DELEGATE = "rmWjCGeLtuLGerEuvHDkrsr46ej2Ni13f";

async function tryPayload(permission: string | number) {
  const txjson = { TransactionType: "DelegateSet", Account: TREASURY, Authorize: DELEGATE, Permissions: [{ Permission: { PermissionValue: permission } }] };
  const res = await xummFetch("https://xumm.app/api/v1/platform/payload", {
    method: "POST",
    body: JSON.stringify({
      txjson,
      options: { expire: 60 },
      custom_meta: {
        identifier: `xrplhub_perm_grant_${Date.now()}`,
        instruction: "XRPLHub TEST — grant rmWjCGeL… ONE harmless permission (AccountEmailHashSet: change the unused EmailHash field). Holds 0.2 XRP until revoked.",
      },
    }),
  });
  const body = await res.json().catch(() => null);
  return { permission, status: res.status, uuid: body?.uuid ?? null, deep_link: body?.next?.always ?? null, error: body?.error ?? null, txjson };
}

export async function POST(req: Request) {
  if (!isAdmin(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const byName = await tryPayload("AccountEmailHashSet");
  if (byName.uuid) return Response.json(byName);
  const byNumber = await tryPayload(65541);
  return Response.json({ byName, byNumber });
}

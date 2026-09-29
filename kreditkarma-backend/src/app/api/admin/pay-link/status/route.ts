// src/app/api/admin/pay-link/status/route.ts
// GET ?uuid= -> { state, txid } for a payload created by POST /api/admin/pay-link. Admin-gated (unlike
// the public checkout/xaman/status, this returns the actual txid once signed, so the admin dashboard's
// one-tap grant payout can auto-fill it into /api/grants/approve without the admin copy-pasting anything).
import { NextResponse } from "next/server";
import { isAdmin, adminUnauthorized } from "@/lib/adminAuth";
import { xummConfigured, getPayloadStatus } from "@/lib/xumm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isAdmin(req)) return adminUnauthorized();
  const uuid = new URL(req.url).searchParams.get("uuid");
  if (!uuid) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  if (!xummConfigured()) return NextResponse.json({ state: "pending", txid: null });
  try {
    const s = await getPayloadStatus(uuid);
    return NextResponse.json({ state: s.state, txid: s.txid });
  } catch {
    return NextResponse.json({ state: "pending", txid: null });
  }
}

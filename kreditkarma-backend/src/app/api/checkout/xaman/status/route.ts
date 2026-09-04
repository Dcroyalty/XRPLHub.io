// app/api/checkout/xaman/status/route.ts
// GET ?uuid= -> { state: "pending" | "signed" | "rejected" | "expired" | "not_found" }
//
// Fast UX feedback only ("you rejected it", "request expired") so the buyer
// isn't staring at an unexplained wait. The AUTHORITATIVE check is
// /api/checkout/status, which confirms the payment on-ledger and mints the key.
// On any Xaman error (incl. 429) this degrades to "pending" — never blocks.

import { NextResponse } from "next/server";
import { xummConfigured, getPayloadStatus } from "@/lib/xumm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const uuid = new URL(req.url).searchParams.get("uuid");
  if (!uuid) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!xummConfigured()) {
    return NextResponse.json({ state: "pending" });
  }
  try {
    const s = await getPayloadStatus(uuid);
    return NextResponse.json({ state: s.state });
  } catch {
    return NextResponse.json({ state: "pending" });
  }
}

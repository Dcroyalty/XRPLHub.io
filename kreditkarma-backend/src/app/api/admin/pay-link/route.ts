// src/app/api/admin/pay-link/route.ts
// Admin-gated: build a Xaman payload that PRE-FILLS an XRP Payment, so signing
// skips Xaman's compose/recipient screen (that lookup hangs on an unactivated
// destination). Payment transactions only — nothing else.
//
//   curl -sX POST https://www.xrplhub.io/api/admin/pay-link \
//     -H "authorization: Bearer $ADMIN_API_TOKEN" -H "content-type: application/json" \
//     -d '{"destination":"r...","drops":"1300000","instruction":"..."}'

import { NextResponse } from "next/server";
import { isAdmin, adminUnauthorized } from "@/lib/adminAuth";
import { createPayload, xummConfigured, XummRateLimitError } from "@/lib/xumm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const R_ADDR = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

export async function POST(req: Request) {
  if (!isAdmin(req)) return adminUnauthorized();
  if (!xummConfigured()) {
    return NextResponse.json({ error: "xaman_unavailable" }, { status: 503 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    destination?: string;
    drops?: string | number;
    destinationTag?: number;
    instruction?: string;
    expireMinutes?: number;
  };

  const destination = String(body.destination ?? "").trim();
  if (!R_ADDR.test(destination)) {
    return NextResponse.json({ error: "bad_request", message: "destination must be a valid r-address" }, { status: 400 });
  }
  const drops = String(body.drops ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(drops)) {
    return NextResponse.json({ error: "bad_request", message: "drops must be a positive integer string" }, { status: 400 });
  }

  const txjson: Record<string, unknown> = {
    TransactionType: "Payment",
    Destination: destination,
    Amount: drops,
  };
  if (typeof body.destinationTag === "number" && Number.isInteger(body.destinationTag)) {
    txjson.DestinationTag = body.destinationTag;
  }

  try {
    const p = await createPayload({
      txjson,
      submit: true,
      expireMinutes: Math.min(60, Math.max(5, body.expireMinutes ?? 20)),
      identifier: `xrplhub_paylink_${Date.now()}`,
      instruction: body.instruction ?? `XRPLHub — pay ${Number(drops) / 1_000_000} XRP to ${destination}`,
    });
    return NextResponse.json({
      uuid: p.uuid,
      deepLink: p.deepLink,
      qrPng: p.qrPng,
      expiresIn: p.expiresIn,
      txjson,
    });
  } catch (e) {
    if (e instanceof XummRateLimitError) {
      return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    }
    console.error("[admin/pay-link]", e);
    return NextResponse.json({ error: "xaman_error", message: e instanceof Error ? e.message : "unknown" }, { status: 502 });
  }
}

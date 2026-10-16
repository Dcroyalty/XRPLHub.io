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
import { isValidXrplAddress } from "@/lib/address";
import { NOT_A_PERSONAL_WALLET } from "@/lib/grantsPool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isAdmin(req)) return adminUnauthorized();
  if (!xummConfigured()) {
    return NextResponse.json({ error: "xaman_unavailable" }, { status: 503 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    destination?: string;
    drops?: string | number;
    destinationTag?: number;
    rlusd?: string; // pay this many RLUSD instead of XRP drops (grants are paid in RLUSD)
    account?: string; // pre-fill the paying account (the grants pool), so Xaman signs from it
    instruction?: string;
    expireMinutes?: number;
  };

  const destination = String(body.destination ?? "").trim();
  if (!isValidXrplAddress(destination)) {
    return NextResponse.json({ error: "bad_request", message: "destination must be a valid r-address" }, { status: 400 });
  }
  if (NOT_A_PERSONAL_WALLET[destination]) {
    return NextResponse.json({ error: "refused", message: `Not paying ${destination}: ${NOT_A_PERSONAL_WALLET[destination]}.` }, { status: 400 });
  }
  const drops = String(body.drops ?? "").trim();
  const rlusd = body.rlusd != null ? String(body.rlusd).trim() : null;
  if (rlusd != null && !/^[0-9]+(\.[0-9]{1,6})?$/.test(rlusd)) {
    return NextResponse.json({ error: "bad_request", message: "rlusd must be a positive amount" }, { status: 400 });
  }
  if (rlusd == null && !/^[1-9][0-9]*$/.test(drops)) {
    return NextResponse.json({ error: "bad_request", message: "drops must be a positive integer string" }, { status: 400 });
  }

  const txjson: Record<string, unknown> = {
    TransactionType: "Payment",
    Destination: destination,
    Amount: rlusd != null
      ? { currency: "524C555344000000000000000000000000000000", issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De", value: rlusd }
      : drops,
  };
  if (body.account && isValidXrplAddress(String(body.account))) txjson.Account = String(body.account);
  if (typeof body.destinationTag === "number" && Number.isInteger(body.destinationTag)) {
    txjson.DestinationTag = body.destinationTag;
  }

  try {
    const p = await createPayload({
      txjson,
      submit: true,
      expireMinutes: Math.min(60, Math.max(5, body.expireMinutes ?? 20)),
      identifier: `xrplhub_paylink_${Date.now()}`,
      instruction: body.instruction ?? (rlusd != null ? `XRPLHub — pay ${rlusd} RLUSD to ${destination}` : `XRPLHub — pay ${Number(drops) / 1_000_000} XRP to ${destination}`),
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

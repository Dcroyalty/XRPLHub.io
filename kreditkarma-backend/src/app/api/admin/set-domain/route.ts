// src/app/api/admin/set-domain/route.ts
// Admin-gated: build a Xaman payload for ONE fixed transaction — an AccountSet that sets the
// Domain field on the treasury, so the account points back at the host serving
// /.well-known/xrp-ledger.toml (the second half of XRPL account verification; explorers such as
// Bithomp and XRPScan read both directions). Nothing else can be built here: the account is
// pinned to TREASURY and the domain must be one of the two hosts below.
//
//   curl -sX POST https://www.xrplhub.io/api/admin/set-domain \
//     -H "authorization: Bearer $ADMIN_API_TOKEN" -H "content-type: application/json" \
//     -d '{}'                                   # default: www.xrplhub.io
//     -d '{"domain":"xrplhub.io"}'              # only if the apex serves the toml itself
//
// The domain must equal the host that serves the toml with no redirect. xrplhub.io is a
// Vercel domain-level redirect to www.xrplhub.io, so www is the default.

import { NextResponse } from "next/server";
import { isAdmin, adminUnauthorized } from "@/lib/adminAuth";
import { createPayload, xummConfigured, XummRateLimitError } from "@/lib/xumm";
import { TREASURY } from "@/lib/pricing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_DOMAINS = ["www.xrplhub.io", "xrplhub.io"] as const;

export async function POST(req: Request) {
  if (!isAdmin(req)) return adminUnauthorized();
  if (!xummConfigured()) {
    return NextResponse.json({ error: "xaman_unavailable" }, { status: 503 });
  }

  const body = (await req.json().catch(() => ({}))) as { domain?: string };
  const domain = String(body.domain ?? ALLOWED_DOMAINS[0]).trim().toLowerCase();
  if (!(ALLOWED_DOMAINS as readonly string[]).includes(domain)) {
    return NextResponse.json(
      { error: "bad_request", message: `domain must be one of: ${ALLOWED_DOMAINS.join(", ")}` },
      { status: 400 },
    );
  }

  // Domain is the ASCII hostname, hex-encoded. `Account` pins the signer: Xaman will only let the
  // treasury sign this payload.
  const txjson: Record<string, unknown> = {
    TransactionType: "AccountSet",
    Account: TREASURY,
    Domain: Buffer.from(domain, "ascii").toString("hex").toUpperCase(),
  };

  try {
    const p = await createPayload({
      txjson,
      submit: true,
      expireMinutes: 60,
      identifier: `xrplhub_setdomain_${Date.now()}`,
      instruction: `XRPLHub — set the treasury's Domain to ${domain} (links the account to /.well-known/xrp-ledger.toml). No funds move.`,
    });
    return NextResponse.json({
      uuid: p.uuid,
      deepLink: p.deepLink,
      qrPng: p.qrPng,
      expiresIn: p.expiresIn,
      domain,
      txjson,
    });
  } catch (e) {
    if (e instanceof XummRateLimitError) {
      return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    }
    console.error("[admin/set-domain]", e);
    return NextResponse.json({ error: "xaman_error", message: e instanceof Error ? e.message : "unknown" }, { status: 502 });
  }
}

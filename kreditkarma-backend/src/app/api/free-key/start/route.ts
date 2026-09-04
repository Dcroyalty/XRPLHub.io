// app/api/free-key/start/route.ts
// POST -> starts a free-tier key claim. Returns:
//   - challenge { id, hex }     : single-use, 10-min, IP-bound. An injected
//                                 wallet (Crossmark / GemWallet) signs `hex`;
//                                 the server verifies it in /api/free-key/claim.
//   - uuid / qrPng / deepLink   : Xaman SignIn payload (only when Xaman is
//                                 configured). Kept at top level so the
//                                 existing Xaman flow is unchanged.
// No body. Per-IP rate limited either way.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { createPayload, xummConfigured, XummRateLimitError } from "@/lib/xumm";
import {
  FREE_KEY_IDENTIFIER_PREFIX,
  START_PER_IP_PER_HOUR,
  SIGNIN_EXPIRE_MINUTES,
  clientIp,
} from "@/lib/freeKey";
import { randomBytes } from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ip = clientIp(req);

  const hourAgo = new Date(Date.now() - 60 * 60_000);
  const recent = await prisma.freeKeySignup.count({
    where: { ip, step: "start", createdAt: { gte: hourAgo } },
  });
  if (recent >= START_PER_IP_PER_HOUR) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many attempts. Try again in an hour." },
      { status: 429, headers: { "Retry-After": "3600" } }
    );
  }

  // Challenge for injected wallets — always issued.
  const hex = randomBytes(32).toString("hex").toUpperCase();
  const challenge = await prisma.signInChallenge.create({ data: { hex, ip } });

  // Xaman SignIn payload — only when Xaman is configured.
  let xaman: { uuid: string; qrPng: string | null; deepLink: string | null } | null = null;
  if (xummConfigured()) {
    try {
      const p = await createPayload({
        txjson: { TransactionType: "SignIn" },
        submit: false,
        identifier: FREE_KEY_IDENTIFIER_PREFIX + randomBytes(12).toString("hex"),
        instruction:
          "XRPLHub — claim your free API key\nSign in to prove you control this wallet. No transaction, no funds move.",
        expireMinutes: SIGNIN_EXPIRE_MINUTES,
      });
      xaman = { uuid: p.uuid, qrPng: p.qrPng, deepLink: p.deepLink };
    } catch (e) {
      if (!(e instanceof XummRateLimitError)) console.error("[free-key/start] xaman", e);
      // fall through — the injected path still works
    }
  }

  await prisma.freeKeySignup.create({ data: { ip, step: "start" } });

  return NextResponse.json({
    challenge: { id: challenge.id, hex },
    // Xaman fields at top level (unchanged shape for the existing flow):
    uuid: xaman?.uuid ?? null,
    qrPng: xaman?.qrPng ?? null,
    deepLink: xaman?.deepLink ?? null,
    xamanAvailable: xaman != null,
    expiresIn: SIGNIN_EXPIRE_MINUTES * 60,
  });
}

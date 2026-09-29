// src/app/api/admin/auth/start/route.ts
// POST -> starts an admin SignIn. Same shape and same underlying mechanism as
// /api/free-key/start (a Xaman SignIn payload + a challenge for injected wallets) --
// see src/lib/freeKey.ts. Whether the signing wallet is actually an admin is decided
// at /api/admin/auth/claim, never here (this route hands out no privilege by itself).
// No body. Per-IP rate limited.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { createPayload, xummConfigured, XummRateLimitError } from "@/lib/xumm";
import { rateLimit, rateLimited } from "@/lib/rateLimit";
import { clientIp } from "@/lib/freeKey";
import { randomBytes } from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADMIN_SIGNIN_IDENTIFIER_PREFIX = "xrplhub_admin_";
const SIGNIN_EXPIRE_MINUTES = 5;

export async function POST(req: Request) {
  const rl = rateLimit(req, "admin-auth-start", 10, 60_000);
  if (!rl.ok) return rateLimited(rl);

  const hex = randomBytes(32).toString("hex").toUpperCase();
  const challenge = await prisma.signInChallenge.create({ data: { hex, ip: clientIp(req) } });

  let xaman: { uuid: string; qrPng: string | null; deepLink: string | null } | null = null;
  if (xummConfigured()) {
    try {
      const p = await createPayload({
        txjson: { TransactionType: "SignIn" },
        submit: false,
        identifier: ADMIN_SIGNIN_IDENTIFIER_PREFIX + randomBytes(12).toString("hex"),
        instruction: "XRPLHub Admin — sign in\nProves you control this wallet. No transaction, no funds move.",
        expireMinutes: SIGNIN_EXPIRE_MINUTES,
      });
      xaman = { uuid: p.uuid, qrPng: p.qrPng, deepLink: p.deepLink };
    } catch (e) {
      if (!(e instanceof XummRateLimitError)) console.error("[admin/auth/start] xaman", e);
    }
  }

  return NextResponse.json({
    challenge: { id: challenge.id, hex },
    uuid: xaman?.uuid ?? null,
    qrPng: xaman?.qrPng ?? null,
    deepLink: xaman?.deepLink ?? null,
    xamanAvailable: xaman != null,
    expiresIn: SIGNIN_EXPIRE_MINUTES * 60,
  });
}

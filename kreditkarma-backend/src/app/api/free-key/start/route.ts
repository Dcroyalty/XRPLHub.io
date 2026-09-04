// app/api/free-key/start/route.ts
// POST -> creates a Xaman SignIn payload for a free-tier key claim.
// No body. The buyer signs in Xaman to prove wallet control; the wallet
// address is read back server-side in /api/free-key/claim.

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
  if (!xummConfigured()) {
    return NextResponse.json(
      { error: "xaman_unavailable", message: "Free signup is temporarily unavailable — email support@xrplhub.io." },
      { status: 503 }
    );
  }

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

  const identifier = FREE_KEY_IDENTIFIER_PREFIX + randomBytes(12).toString("hex");

  try {
    const p = await createPayload({
      txjson: { TransactionType: "SignIn" },
      submit: false,
      identifier,
      instruction: "XRPLHub — claim your free API key\nSign in to prove you control this wallet. No transaction, no funds move.",
      expireMinutes: SIGNIN_EXPIRE_MINUTES,
    });
    await prisma.freeKeySignup.create({ data: { ip, step: "start" } });
    return NextResponse.json({
      uuid: p.uuid,
      qrPng: p.qrPng,
      deepLink: p.deepLink,
      expiresIn: SIGNIN_EXPIRE_MINUTES * 60,
    });
  } catch (e) {
    if (e instanceof XummRateLimitError) {
      return NextResponse.json(
        { error: "busy", message: "Xaman is busy — try again in a moment." },
        { status: 429 }
      );
    }
    console.error("[free-key/start]", e);
    return NextResponse.json(
      { error: "xaman_error", message: "Could not open Xaman. Try again shortly." },
      { status: 502 }
    );
  }
}

// src/app/api/admin/auth/claim/route.ts
// POST — resolves the signing wallet by the same two proofs free-key/claim uses (Xaman uuid, or an
// injected-wallet challenge+signature), and grants an admin session ONLY if that wallet is in
// ADMIN_WALLETS. Everyone else gets "not_admin" -- proving control of a wallet is necessary but not
// sufficient. On success, sets an httpOnly, Secure, SameSite=Strict session cookie; nothing about the
// wallet's key ever touches the server.
//
//   { uuid }                                                    -- Xaman path, polled ~3s
//   { challengeId, walletId, address, publicKey, signature }     -- injected wallet, one shot
//
// Returns: pending | rejected | expired | bad_signature | not_admin | error | { status:"ok", wallet }

import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { getPayloadStatus, xummConfigured, XummRateLimitError } from "@/lib/xumm";
import { isValidXrplAddress } from "@/lib/engine";
import { CHALLENGE_TTL_MS, verifyInjectedProof } from "@/lib/freeKey";
import { ADMIN_SESSION_COOKIE, SESSION_TTL_MS, adminWallets, signAdminSession } from "@/lib/adminSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADMIN_SIGNIN_IDENTIFIER_PREFIX = "xrplhub_admin_";

type Body = {
  uuid?: string;
  challengeId?: string;
  walletId?: string;
  address?: string;
  publicKey?: string;
  signature?: string;
};

async function resolveViaXaman(uuid: string): Promise<{ wallet: string } | { status: string }> {
  if (!xummConfigured()) return { status: "error" };
  let payload;
  try {
    payload = await getPayloadStatus(uuid);
  } catch (e) {
    if (e instanceof XummRateLimitError) return { status: "pending" };
    console.error("[admin/auth/claim] xaman status", e);
    return { status: "pending" };
  }
  if (payload.state === "pending") return { status: "pending" };
  if (payload.state === "rejected") return { status: "rejected" };
  if (payload.state === "expired" || payload.state === "not_found") return { status: "expired" };
  if (!payload.identifier?.startsWith(ADMIN_SIGNIN_IDENTIFIER_PREFIX)) return { status: "error" };
  const wallet = (payload.signer ?? "").trim();
  if (!wallet || !isValidXrplAddress(wallet)) return { status: "error" };
  return { wallet };
}

async function resolveViaInjected(b: Body): Promise<{ wallet: string } | { status: string }> {
  if (!b.challengeId || !b.address || !b.publicKey || !b.signature) return { status: "error" };
  if (!isValidXrplAddress(b.address)) return { status: "bad_signature" };

  const challenge = await prisma.signInChallenge.findUnique({ where: { id: b.challengeId } });
  if (!challenge) return { status: "expired" };
  if (challenge.consumedAt) return { status: "expired" };
  if (Date.now() - challenge.createdAt.getTime() > CHALLENGE_TTL_MS) return { status: "expired" };

  const consumed = await prisma.signInChallenge.updateMany({
    where: { id: challenge.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (consumed.count !== 1) return { status: "expired" };

  const v = verifyInjectedProof({ address: b.address, publicKey: b.publicKey, signature: b.signature, challengeHex: challenge.hex });
  if (!v.ok) return { status: "bad_signature" };

  return { wallet: b.address };
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Body;

  const resolved = body.uuid ? await resolveViaXaman(body.uuid) : await resolveViaInjected(body);
  if ("status" in resolved) {
    return NextResponse.json({ status: resolved.status });
  }
  const wallet = resolved.wallet;

  if (!adminWallets().includes(wallet)) {
    return NextResponse.json({ status: "not_admin" });
  }

  const session = signAdminSession(wallet);
  if (!session) {
    // ADMIN_API_TOKEN unset -- fail closed, same as every other admin path.
    return NextResponse.json({ status: "error", message: "Admin auth is not configured on the server." }, { status: 503 });
  }

  const res = NextResponse.json({ status: "ok", wallet });
  res.cookies.set(ADMIN_SESSION_COOKIE, session, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  return res;
}

// app/api/free-key/claim/route.ts
// POST — resolves the claiming wallet by ONE of two proofs, then issues one
// free key. Two request shapes:
//
//   Xaman (polled ~3s while the QR is up):
//     { uuid }
//
//   Injected wallet — Crossmark / GemWallet (one shot):
//     { challengeId, walletId, address, publicKey, signature }
//
// Returns:
//   { status: "pending" }                 — Xaman not signed yet
//   { status: "rejected" | "expired" }    — declined / timed out / bad challenge
//   { status: "bad_signature" }           — injected proof failed verification
//   { status: "rate_limited" }            — too many keys from this IP
//   { status: "inactive_wallet" }         — wallet not activated on mainnet
//   { status: "already_claimed" | "revoked" }
//   { status: "issued", key, plan, note } — FIRST success only (key shown once)

import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { getPayloadStatus, xummConfigured, XummRateLimitError } from "@/lib/xumm";
import { generateApiKey } from "@/lib/keys";
import { isValidXrplAddress } from "@/lib/engine";
import {
  FREE_KEY_IDENTIFIER_PREFIX,
  CLAIM_PER_IP_PER_DAY,
  CHALLENGE_TTL_MS,
  clientIp,
  walletIsActivated,
  verifyInjectedProof,
} from "@/lib/freeKey";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FREE_PLAN = "free";

type Body = {
  uuid?: string;
  challengeId?: string;
  walletId?: string;
  address?: string;
  publicKey?: string;
  signature?: string;
};

// Resolve the wallet address from a Xaman uuid. Returns a status string when
// the flow is not (yet) complete, or { wallet } when it is.
async function resolveViaXaman(uuid: string): Promise<{ wallet: string } | { status: string }> {
  if (!xummConfigured()) return { status: "error" };
  let payload;
  try {
    payload = await getPayloadStatus(uuid);
  } catch (e) {
    if (e instanceof XummRateLimitError) return { status: "pending" };
    console.error("[free-key/claim] xaman status", e);
    return { status: "pending" };
  }
  if (payload.state === "pending") return { status: "pending" };
  if (payload.state === "rejected") return { status: "rejected" };
  if (payload.state === "expired" || payload.state === "not_found") return { status: "expired" };
  if (!payload.identifier?.startsWith(FREE_KEY_IDENTIFIER_PREFIX)) return { status: "error" };
  const wallet = (payload.signer ?? "").trim();
  if (!wallet || !isValidXrplAddress(wallet)) return { status: "error" };
  return { wallet };
}

// Resolve + verify an injected-wallet proof. Consumes the challenge (single use).
async function resolveViaInjected(b: Body): Promise<{ wallet: string } | { status: string }> {
  if (!b.challengeId || !b.address || !b.publicKey || !b.signature) return { status: "error" };
  if (!isValidXrplAddress(b.address)) return { status: "bad_signature" };

  const challenge = await prisma.signInChallenge.findUnique({ where: { id: b.challengeId } });
  if (!challenge) return { status: "expired" };
  if (challenge.consumedAt) return { status: "expired" };
  if (Date.now() - challenge.createdAt.getTime() > CHALLENGE_TTL_MS) return { status: "expired" };

  // Consume atomically — the first request wins, replays lose.
  const consumed = await prisma.signInChallenge.updateMany({
    where: { id: challenge.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (consumed.count !== 1) return { status: "expired" };

  const v = verifyInjectedProof({
    address: b.address,
    publicKey: b.publicKey,
    signature: b.signature,
    challengeHex: challenge.hex,
  });
  if (!v.ok) return { status: "bad_signature" };

  return { wallet: b.address };
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Body;

  const resolved = body.uuid
    ? await resolveViaXaman(body.uuid)
    : await resolveViaInjected(body);

  if ("status" in resolved) {
    return NextResponse.json({ status: resolved.status });
  }
  const wallet = resolved.wallet;

  // ---- shared issuance path ----

  // Already has a free key? (also the race guard — ownerWallet is @unique)
  const existing = await prisma.apiKey.findUnique({ where: { ownerWallet: wallet } });
  if (existing) {
    return NextResponse.json({ status: existing.active ? "already_claimed" : "revoked" });
  }

  // Anti-farming: the wallet must be an activated mainnet account.
  if (!(await walletIsActivated(wallet))) {
    return NextResponse.json({ status: "inactive_wallet" });
  }

  // Per-IP issuance cap (successful claims only).
  const ip = clientIp(req);
  const dayAgo = new Date(Date.now() - 24 * 60 * 60_000);
  const issuedFromIp = await prisma.freeKeySignup.count({
    where: { ip, step: "claim", createdAt: { gte: dayAgo } },
  });
  if (issuedFromIp >= CLAIM_PER_IP_PER_DAY) {
    return NextResponse.json({ status: "rate_limited" }, { status: 429 });
  }

  const gen = generateApiKey();
  try {
    await prisma.apiKey.create({
      data: {
        keyPrefix: gen.keyPrefix,
        keyHash: gen.keyHash,
        name: `free:${wallet.slice(0, 10)}`,
        plan: FREE_PLAN,
        ownerWallet: wallet,
      },
    });
  } catch {
    return NextResponse.json({ status: "already_claimed" }); // unique(ownerWallet) race
  }

  await prisma.freeKeySignup.create({ data: { ip, wallet, step: "claim" } });

  return NextResponse.json(
    {
      status: "issued",
      key: gen.full,
      plan: FREE_PLAN,
      wallet,
      note: "Store this key now — it cannot be shown again.",
    },
    { status: 201 }
  );
}

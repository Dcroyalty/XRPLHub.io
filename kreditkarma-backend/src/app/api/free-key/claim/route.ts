// app/api/free-key/claim/route.ts
// POST { uuid } -> polled by the client every ~3s after the SignIn QR is shown.
// Returns:
//   { status: "pending" }                              — not signed yet
//   { status: "rejected" | "expired" }                 — user declined / timed out
//   { status: "rate_limited" }                         — too many keys from this IP
//   { status: "already_claimed" }                      — this wallet already has a free key
//   { status: "issued", key, plan, note }              — FIRST success only (key shown once)
//   { status: "already_issued" }                       — polled again after success

import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { getPayloadStatus, xummConfigured, XummRateLimitError } from "@/lib/xumm";
import { generateApiKey } from "@/lib/keys";
import { isValidXrplAddress } from "@/lib/engine";
import { FREE_KEY_IDENTIFIER_PREFIX, CLAIM_PER_IP_PER_DAY, clientIp, walletIsActivated } from "@/lib/freeKey";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FREE_PLAN = "free";

export async function POST(req: Request) {
  if (!xummConfigured()) {
    return NextResponse.json({ status: "error", message: "unavailable" }, { status: 503 });
  }

  const body = (await req.json().catch(() => ({}))) as { uuid?: string };
  if (!body.uuid) {
    return NextResponse.json({ status: "error", message: "missing uuid" }, { status: 400 });
  }

  let payload;
  try {
    payload = await getPayloadStatus(body.uuid);
  } catch (e) {
    if (e instanceof XummRateLimitError) return NextResponse.json({ status: "pending" });
    console.error("[free-key/claim] status", e);
    return NextResponse.json({ status: "pending" });
  }

  if (payload.state === "pending") return NextResponse.json({ status: "pending" });
  if (payload.state === "rejected") return NextResponse.json({ status: "rejected" });
  if (payload.state === "expired" || payload.state === "not_found") {
    return NextResponse.json({ status: "expired" });
  }

  // signed — make sure this is one of OUR free-key SignIn payloads
  if (!payload.identifier?.startsWith(FREE_KEY_IDENTIFIER_PREFIX)) {
    return NextResponse.json({ status: "error", message: "not a free-key request" }, { status: 400 });
  }

  const wallet = (payload.signer ?? "").trim();
  if (!wallet || !isValidXrplAddress(wallet)) {
    return NextResponse.json({ status: "error", message: "could not read wallet" }, { status: 422 });
  }

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
    // unique(ownerWallet) race — another request just claimed it.
    return NextResponse.json({ status: "already_claimed" });
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

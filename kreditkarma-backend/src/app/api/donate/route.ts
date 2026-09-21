// src/app/api/donate/route.ts
// Donor self-report: after a donor sends XRP/RLUSD to the treasury they POST the
// tx hash here so we can attach a message and keep a donor record alongside the
// on-chain TreasuryStatsBar count.
//
// GET  -> { treasuryAddress, network }                                   (public)
// POST -> { fromAddress, txHash, amount, currency, message? } -> Donation row   (ADMIN-ONLY, ADMIN_API_TOKEN)
//
// POST used to be open: anyone could file a donation row with an invented hash/amount, or overwrite the message on
// someone else's hash. A donation is a payment on the public ledger — the ledger is the record; this table is only an
// operator's notebook, so only the operator can write it.
//
// The handler used to write columns that don't exist on the Donation model
// (email/wallet/note, string amount, null txHash) so EVERY call failed the DB
// write while still returning 200 — a silent no-op on the grants-funding path.
// This matches the live schema exactly and is idempotent on txHash.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { notifyError } from "@/lib/notify";
import { isAdmin, adminUnauthorized } from "@/lib/adminAuth";
import { isValidXrplAddress } from "@/lib/address";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TREASURY = process.env.TREASURY_ADDRESS || "rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF";
const TX_RE = /^[0-9A-Fa-f]{64}$/;

export async function GET() {
  return NextResponse.json({ treasuryAddress: TREASURY, network: "xrpl-mainnet" });
}

export async function POST(req: NextRequest) {
  if (!isAdmin(req)) return adminUnauthorized();
  const b = (await req.json().catch(() => ({}))) as {
    fromAddress?: string;
    txHash?: string;
    amount?: number | string;
    currency?: string;
    message?: string;
    note?: string; // legacy field name — accepted as an alias for message
  };

  const fromAddress = String(b.fromAddress ?? "").trim();
  const txHash = String(b.txHash ?? "").trim();
  const amount = Number(b.amount);
  const currency = String(b.currency ?? "XRP").toUpperCase();
  const message = (b.message ?? b.note) ? String(b.message ?? b.note).slice(0, 500) : null;

  if (!isValidXrplAddress(fromAddress)) {
    return NextResponse.json({ ok: false, error: "fromAddress must be a valid XRPL address" }, { status: 400 });
  }
  if (!TX_RE.test(txHash)) {
    return NextResponse.json({ ok: false, error: "txHash must be a 64-hex transaction hash" }, { status: 400 });
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ ok: false, error: "amount must be a positive number" }, { status: 400 });
  }
  if (currency !== "XRP" && currency !== "RLUSD") {
    return NextResponse.json({ ok: false, error: "currency must be XRP or RLUSD" }, { status: 400 });
  }

  try {
    // Idempotent: the same tx hash reported twice returns the existing row.
    const row = await prisma.donation.upsert({
      where: { txHash },
      create: { fromAddress, txHash, amount, currency, message },
      update: { message: message ?? undefined },
    });
    return NextResponse.json({ ok: true, id: row.id, recorded: true });
  } catch (err) {
    // The on-chain donation already happened; this endpoint is a record-keeping
    // helper, not the money path — so still return 200. But a write failure here
    // means we've lost the donor record on the grants-funding path, so it's loud.
    await notifyError("POST /api/donate", err, { fromAddress, txHash, amount, currency });
    return NextResponse.json({ ok: false, error: "record write failed", recorded: false });
  }
}

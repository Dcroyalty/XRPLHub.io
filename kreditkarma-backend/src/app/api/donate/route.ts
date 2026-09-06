// src/app/api/donate/route.ts
// Donor self-report: after a donor sends XRP/RLUSD to the treasury they (or an
// integrator via src/lib/api-client.ts recordDonation) POST the tx hash here so
// we can attach a message and keep a donor record alongside the on-chain
// TreasuryStatsBar count.
//
// GET  -> { treasuryAddress, network }
// POST -> { fromAddress, txHash, amount, currency, message? } -> Donation row
//
// The handler used to write columns that don't exist on the Donation model
// (email/wallet/note, string amount, null txHash) so EVERY call failed the DB
// write while still returning 200 — a silent no-op on the grants-funding path.
// This matches the live schema exactly and is idempotent on txHash.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TREASURY = process.env.TREASURY_ADDRESS || "rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF";
const TX_RE = /^[0-9A-Fa-f]{64}$/;
const ADDR_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

export async function GET() {
  return NextResponse.json({ treasuryAddress: TREASURY, network: "xrpl-mainnet" });
}

export async function POST(req: NextRequest) {
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

  if (!ADDR_RE.test(fromAddress)) {
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
    // helper, not the money path — so still return 200. (Fix #2 wires this into
    // notifyError so a record-write failure on the grants-funding path is loud.)
    console.error("[donate]", err instanceof Error ? err.message : "donate write failed");
    return NextResponse.json({ ok: false, error: "record write failed", recorded: false });
  }
}

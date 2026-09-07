// src/lib/screenAnchor.ts
// Daily Merkle anchor of OFAC screening receipts. Same wallet and hash scheme
// as the MPT registry anchor (src/lib/mptAnchor.ts); SEPARATE memo type,
// SEPARATE batch, SEPARATE interval gate.
//
// Cron-agnostic by design: it anchors "all unanchored receipts" whenever the
// last anchor is older than SCREEN_ANCHOR_MIN_INTERVAL_MS. A daily cron fires
// it once per day; an hourly trigger (external scheduler hitting
// POST /api/attest/anchor) would produce hourly trees with no code change.
// `force` skips the interval gate (admin/manual only).

import type { PrismaClient } from "@prisma/client";
import { submitMemoAnchor, anchorSigningKeyPresent } from "./anchorMemo";
import { SCREEN_CANON_VERSION, merkleRootFromLeafHashes } from "./screenCanon";
import { notifyError } from "./notify";

export const SCREEN_MEMO_TYPE = `XRPLHub-Screening-Attestation/${SCREEN_CANON_VERSION}`;
const SCREEN_ANCHOR_MIN_INTERVAL_MS = 20 * 60 * 60 * 1000; // ~once a day

export interface ScreenAnchorAttempt {
  attempted: boolean;
  submitted: boolean;
  reason: string;
  leafCount: number;
  merkleRoot?: string;
  anchorId?: string;
  txHash?: string;
  faultClass?: "misconfigured" | "transient";
}

export async function maybeAnchorScreeningReceipts(
  prisma: PrismaClient,
  opts: { force?: boolean } = {}
): Promise<ScreenAnchorAttempt> {
  const unanchored = await prisma.screeningReceipt.findMany({
    where: { anchorId: null },
    orderBy: { queryId: "asc" },
  });

  if (unanchored.length === 0) {
    return { attempted: false, submitted: false, reason: "no unanchored receipts", leafCount: 0 };
  }

  const last = await prisma.screeningAnchor.findFirst({
    where: { status: "anchored" },
    orderBy: { createdAt: "desc" },
  });
  if (!opts.force && last && Date.now() - last.createdAt.getTime() < SCREEN_ANCHOR_MIN_INTERVAL_MS) {
    return {
      attempted: false,
      submitted: false,
      reason: "last screening anchor was < ~20h ago (pass { force: true } to override)",
      leafCount: unanchored.length,
    };
  }

  const leafHashes = unanchored.map((r) => r.leafHash);
  const merkleRoot = merkleRootFromLeafHashes(leafHashes);
  const rangeStart = unanchored.reduce((a, r) => (r.screenedAt < a ? r.screenedAt : a), unanchored[0].screenedAt);
  const rangeEnd = unanchored.reduce((a, r) => (r.screenedAt > a ? r.screenedAt : a), unanchored[0].screenedAt);
  const ts = new Date().toISOString();
  const memoData = JSON.stringify({
    v: SCREEN_CANON_VERSION,
    root: merkleRoot,
    leaves: unanchored.length,
    rangeStart: rangeStart.toISOString(),
    rangeEnd: rangeEnd.toISOString(),
    ts,
  });

  if (!anchorSigningKeyPresent()) {
    const msg = "ANCHOR_WALLET_SEED not set — screening receipts cannot be anchored on-ledger.";
    const row = await prisma.screeningAnchor.create({
      data: {
        canonVersion: SCREEN_CANON_VERSION,
        merkleRoot,
        leafCount: unanchored.length,
        rangeStart,
        rangeEnd,
        memo: memoData,
        status: "misconfigured",
        error: msg,
      },
    });
    await notifyError("cron screening-anchor", new Error(msg), { leaves: unanchored.length });
    return {
      attempted: false,
      submitted: false,
      faultClass: "misconfigured",
      reason: msg,
      leafCount: unanchored.length,
      merkleRoot,
      anchorId: row.id,
    };
  }

  const row = await prisma.screeningAnchor.create({
    data: {
      canonVersion: SCREEN_CANON_VERSION,
      merkleRoot,
      leafCount: unanchored.length,
      rangeStart,
      rangeEnd,
      memo: memoData,
      status: "pending",
    },
  });

  try {
    const r = await submitMemoAnchor(SCREEN_MEMO_TYPE, memoData);
    if (!r.validated || r.engineResult !== "tesSUCCESS") {
      throw new Error(`tx not successful: engineResult=${r.engineResult}, validated=${r.validated}`);
    }
    await prisma.$transaction([
      prisma.screeningAnchor.update({
        where: { id: row.id },
        data: {
          status: "anchored",
          txHash: r.txHash,
          ledgerIndex: r.ledgerIndex,
          account: r.account,
          feeDrops: r.feeDrops,
          closeTime: r.closeTimeIso ? new Date(r.closeTimeIso) : null,
          anchoredAt: new Date(),
          error: null,
        },
      }),
      prisma.screeningReceipt.updateMany({
        where: { queryId: { in: unanchored.map((u) => u.queryId) } },
        data: { anchorId: row.id },
      }),
    ]);
    return {
      attempted: true,
      submitted: true,
      reason: "anchored",
      leafCount: unanchored.length,
      merkleRoot,
      anchorId: row.id,
      txHash: r.txHash,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const misconfig = /ANCHOR_WALLET_SEED|REFUSING:|derives .* expected/i.test(msg);
    await prisma.screeningAnchor.update({
      where: { id: row.id },
      data: { status: misconfig ? "misconfigured" : "failed", error: msg },
    });
    await notifyError("cron screening-anchor", err, {
      faultClass: misconfig ? "misconfigured" : "transient",
      merkleRoot,
    });
    return {
      attempted: true,
      submitted: false,
      faultClass: misconfig ? "misconfigured" : "transient",
      reason: `screening anchor failed: ${msg}`,
      leafCount: unanchored.length,
      merkleRoot,
      anchorId: row.id,
    };
  }
}

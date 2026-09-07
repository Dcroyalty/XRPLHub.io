// src/lib/underwriteAnchor.ts
// Daily Merkle anchor of underwriting-inputs bundle receipts. Same wallet + hash
// scheme as every other XRPLHub anchor; separate memo type + batch + interval
// gate. Cron-agnostic; `force` skips the gate (admin).

import type { PrismaClient } from "@prisma/client";
import { submitMemoAnchor, anchorSigningKeyPresent } from "./anchorMemo";
import { UNDERWRITE_CANON_VERSION } from "./underwriteCanon";
import { merkleRootFromLeafHashes } from "./merkle";
import { notifyError } from "./notify";

export const UNDERWRITE_MEMO_TYPE = `XRPLHub-Underwrite-Bundle-Anchor/${UNDERWRITE_CANON_VERSION}`;
const MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;

export interface UnderwriteAnchorAttempt {
  attempted: boolean;
  submitted: boolean;
  reason: string;
  leafCount: number;
  merkleRoot?: string;
  anchorId?: string;
  txHash?: string;
  faultClass?: "misconfigured" | "transient";
}

export async function maybeAnchorUnderwriteReceipts(
  prisma: PrismaClient,
  opts: { force?: boolean } = {}
): Promise<UnderwriteAnchorAttempt> {
  const unanchored = await prisma.underwriteBundleReceipt.findMany({
    where: { anchorId: null },
    orderBy: { queryId: "asc" },
  });
  if (unanchored.length === 0) {
    return { attempted: false, submitted: false, reason: "no unanchored bundle receipts", leafCount: 0 };
  }

  const last = await prisma.underwriteBundleAnchor.findFirst({
    where: { status: "anchored" },
    orderBy: { createdAt: "desc" },
  });
  if (!opts.force && last && Date.now() - last.createdAt.getTime() < MIN_INTERVAL_MS) {
    return { attempted: false, submitted: false, reason: "last underwrite anchor was < ~20h ago", leafCount: unanchored.length };
  }

  const leafHashes = unanchored.map((r) => r.leafHash);
  const merkleRoot = merkleRootFromLeafHashes(leafHashes);
  const rangeStart = unanchored.reduce((a, r) => (r.createdAt < a ? r.createdAt : a), unanchored[0].createdAt);
  const rangeEnd = unanchored.reduce((a, r) => (r.createdAt > a ? r.createdAt : a), unanchored[0].createdAt);
  const ts = new Date().toISOString();
  const memoData = JSON.stringify({
    v: UNDERWRITE_CANON_VERSION,
    root: merkleRoot,
    leaves: unanchored.length,
    rangeStart: rangeStart.toISOString(),
    rangeEnd: rangeEnd.toISOString(),
    ts,
  });

  if (!anchorSigningKeyPresent()) {
    const msg = "ANCHOR_WALLET_SEED not set — underwrite bundle receipts cannot be anchored.";
    const row = await prisma.underwriteBundleAnchor.create({
      data: { canonVersion: UNDERWRITE_CANON_VERSION, merkleRoot, leafCount: unanchored.length, rangeStart, rangeEnd, memo: memoData, status: "misconfigured", error: msg },
    });
    await notifyError("cron underwrite-anchor", new Error(msg), { leaves: unanchored.length });
    return { attempted: false, submitted: false, faultClass: "misconfigured", reason: msg, leafCount: unanchored.length, merkleRoot, anchorId: row.id };
  }

  const row = await prisma.underwriteBundleAnchor.create({
    data: { canonVersion: UNDERWRITE_CANON_VERSION, merkleRoot, leafCount: unanchored.length, rangeStart, rangeEnd, memo: memoData, status: "pending" },
  });

  try {
    const r = await submitMemoAnchor(UNDERWRITE_MEMO_TYPE, memoData);
    if (!r.validated || r.engineResult !== "tesSUCCESS") {
      throw new Error(`tx not successful: engineResult=${r.engineResult}, validated=${r.validated}`);
    }
    await prisma.$transaction([
      prisma.underwriteBundleAnchor.update({
        where: { id: row.id },
        data: {
          status: "anchored", txHash: r.txHash, ledgerIndex: r.ledgerIndex, account: r.account,
          feeDrops: r.feeDrops, closeTime: r.closeTimeIso ? new Date(r.closeTimeIso) : null, anchoredAt: new Date(), error: null,
        },
      }),
      prisma.underwriteBundleReceipt.updateMany({
        where: { queryId: { in: unanchored.map((u) => u.queryId) } },
        data: { anchorId: row.id },
      }),
    ]);
    return { attempted: true, submitted: true, reason: "anchored", leafCount: unanchored.length, merkleRoot, anchorId: row.id, txHash: r.txHash };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const misconfig = /ANCHOR_WALLET_SEED|REFUSING:|derives .* expected/i.test(msg);
    await prisma.underwriteBundleAnchor.update({ where: { id: row.id }, data: { status: misconfig ? "misconfigured" : "failed", error: msg } });
    await notifyError("cron underwrite-anchor", err, { faultClass: misconfig ? "misconfigured" : "transient", merkleRoot });
    return { attempted: true, submitted: false, faultClass: misconfig ? "misconfigured" : "transient", reason: `underwrite anchor failed: ${msg}`, leafCount: unanchored.length, merkleRoot, anchorId: row.id };
  }
}

// src/lib/lendingAnchor.ts
// Daily Merkle anchor of XLS-66 lending-exposure snapshots. Same wallet and hash
// scheme as the OFAC screening + MPT registry anchors; SEPARATE memo type,
// SEPARATE batch, SEPARATE interval gate. Cron-agnostic + interval-gated so the
// cadence can tighten later with no code change. `force` skips the gate (admin).
//
// Anchoring a snapshot is what makes it a durable credit record: the leaf commits
// to the exact list of Loan ids observed, so a loan later deleted from the ledger
// is still provably attested to have existed.

import type { PrismaClient } from "@prisma/client";
import { submitMemoAnchor, anchorSigningKeyPresent } from "./anchorMemo";
import { LENDING_CANON_VERSION } from "./lendingCanon";
import { merkleRootFromLeafHashes } from "./merkle";
import { notifyError } from "./notify";

export const LENDING_MEMO_TYPE = `XRPLHub-Lending-Exposure-Anchor/${LENDING_CANON_VERSION}`;
const LENDING_ANCHOR_MIN_INTERVAL_MS = 20 * 60 * 60 * 1000; // ~once a day

export interface LendingAnchorAttempt {
  attempted: boolean;
  submitted: boolean;
  reason: string;
  leafCount: number;
  merkleRoot?: string;
  anchorId?: string;
  txHash?: string;
  faultClass?: "misconfigured" | "transient";
}

export async function maybeAnchorLendingReceipts(
  prisma: PrismaClient,
  opts: { force?: boolean } = {}
): Promise<LendingAnchorAttempt> {
  const unanchored = await prisma.lendingExposureSnapshot.findMany({
    where: { anchorId: null },
    orderBy: { queryId: "asc" },
  });
  if (unanchored.length === 0) {
    return { attempted: false, submitted: false, reason: "no unanchored snapshots", leafCount: 0 };
  }

  const last = await prisma.lendingExposureAnchor.findFirst({
    where: { status: "anchored" },
    orderBy: { createdAt: "desc" },
  });
  if (!opts.force && last && Date.now() - last.createdAt.getTime() < LENDING_ANCHOR_MIN_INTERVAL_MS) {
    return {
      attempted: false,
      submitted: false,
      reason: "last lending anchor was < ~20h ago (pass { force: true } to override)",
      leafCount: unanchored.length,
    };
  }

  const leafHashes = unanchored.map((r) => r.leafHash);
  const merkleRoot = merkleRootFromLeafHashes(leafHashes);
  const rangeStart = unanchored.reduce((a, r) => (r.observedAt < a ? r.observedAt : a), unanchored[0].observedAt);
  const rangeEnd = unanchored.reduce((a, r) => (r.observedAt > a ? r.observedAt : a), unanchored[0].observedAt);
  const ts = new Date().toISOString();
  const memoData = JSON.stringify({
    v: LENDING_CANON_VERSION,
    root: merkleRoot,
    leaves: unanchored.length,
    rangeStart: rangeStart.toISOString(),
    rangeEnd: rangeEnd.toISOString(),
    ts,
  });

  if (!anchorSigningKeyPresent()) {
    const msg = "ANCHOR_WALLET_SEED not set — lending-exposure snapshots cannot be anchored on-ledger.";
    const row = await prisma.lendingExposureAnchor.create({
      data: {
        canonVersion: LENDING_CANON_VERSION,
        merkleRoot,
        leafCount: unanchored.length,
        rangeStart,
        rangeEnd,
        memo: memoData,
        status: "misconfigured",
        error: msg,
      },
    });
    await notifyError("cron lending-anchor", new Error(msg), { leaves: unanchored.length });
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

  const row = await prisma.lendingExposureAnchor.create({
    data: {
      canonVersion: LENDING_CANON_VERSION,
      merkleRoot,
      leafCount: unanchored.length,
      rangeStart,
      rangeEnd,
      memo: memoData,
      status: "pending",
    },
  });

  try {
    const r = await submitMemoAnchor(LENDING_MEMO_TYPE, memoData);
    if (!r.validated || r.engineResult !== "tesSUCCESS") {
      throw new Error(`tx not successful: engineResult=${r.engineResult}, validated=${r.validated}`);
    }
    await prisma.$transaction([
      prisma.lendingExposureAnchor.update({
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
      prisma.lendingExposureSnapshot.updateMany({
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
    await prisma.lendingExposureAnchor.update({
      where: { id: row.id },
      data: { status: misconfig ? "misconfigured" : "failed", error: msg },
    });
    await notifyError("cron lending-anchor", err, {
      faultClass: misconfig ? "misconfigured" : "transient",
      merkleRoot,
    });
    return {
      attempted: true,
      submitted: false,
      faultClass: misconfig ? "misconfigured" : "transient",
      reason: `lending anchor failed: ${msg}`,
      leafCount: unanchored.length,
      merkleRoot,
      anchorId: row.id,
    };
  }
}

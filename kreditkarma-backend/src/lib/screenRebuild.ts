// src/lib/screenRebuild.ts
// Rebuilding a STORED screening receipt into its canonical leaf, of whichever canonVersion it was written under, and the Merkle
// context of the anchor batch it sits in. Shared by GET /api/attest/verify and GET /api/attest/export so the two can never
// disagree about what a receipt says. Read-only.

import type { PrismaClient } from "@prisma/client";
import {
  SCREEN_CANON_VERSION_V1,
  SCREEN_RETENTION_CODE,
  canonScreenJson,
  canonScreenJsonV2,
  leafHashForCanon,
  merkleInclusionProof,
  merkleRootFromLeafHashes,
  renderStatement,
  renderStatementV2,
  screenMemoTypeFor,
  type ProofStep,
  type ScreenLeaf,
  type ScreenLeafV2,
} from "./screenCanon";

export interface ReceiptRowLike {
  queryId: string;
  subjectAddress: string;
  subjectChain: string;
  reference: string | null;
  requestedBy: string;
  screenedAt: Date;
  ledgerIndex: number;
  listsJson: unknown;
  resultJson: unknown;
  engineVersion: string;
  canonVersion: string;
  retentionCode: string | null;
  leafHash: string;
  anchorId: string | null;
  batchId: string | null;
}

export interface RebuiltReceipt {
  canonVersion: string;
  leaf: ScreenLeaf | ScreenLeafV2;
  canonicalJson: string;
  recomputedLeafHash: string;
  leafHashMatches: boolean;
  statement: string;
}

export function rebuildReceipt(row: ReceiptRowLike): RebuiltReceipt {
  const screenedAt = row.screenedAt.toISOString();
  if (row.canonVersion === SCREEN_CANON_VERSION_V1) {
    const leaf: ScreenLeaf = {
      queryId: row.queryId,
      subjectAddress: row.subjectAddress,
      requestedBy: row.requestedBy,
      lists: row.listsJson as ScreenLeaf["lists"],
      method: "exact-match",
      result: row.resultJson as ScreenLeaf["result"],
      engineVersion: row.engineVersion,
      ledgerIndex: row.ledgerIndex,
      screenedAt,
    };
    const h = leafHashForCanon(row.canonVersion, leaf);
    return { canonVersion: row.canonVersion, leaf, canonicalJson: canonScreenJson(leaf), recomputedLeafHash: h, leafHashMatches: h === row.leafHash, statement: renderStatement(leaf) };
  }
  const leaf: ScreenLeafV2 = {
    queryId: row.queryId,
    subjectAddress: row.subjectAddress,
    subjectChain: row.subjectChain as ScreenLeafV2["subjectChain"],
    reference: row.reference,
    requestedBy: row.requestedBy,
    lists: row.listsJson as ScreenLeafV2["lists"],
    method: "exact-match",
    result: row.resultJson as ScreenLeafV2["result"],
    engineVersion: row.engineVersion,
    retention: row.retentionCode ?? SCREEN_RETENTION_CODE,
    ledgerIndex: row.ledgerIndex,
    screenedAt,
  };
  const h = leafHashForCanon(row.canonVersion, leaf);
  return { canonVersion: row.canonVersion, leaf, canonicalJson: canonScreenJsonV2(leaf), recomputedLeafHash: h, leafHashMatches: h === row.leafHash, statement: renderStatementV2(leaf) };
}

export interface AnchorContext {
  anchor: {
    id: string;
    canonVersion: string;
    merkleRoot: string;
    leafCount: number;
    txHash: string | null;
    ledgerIndex: number | null;
    closeTime: Date | null;
    anchoredAt: Date | null;
    account: string | null;
    memo: string;
    status: string;
  };
  memoType: string;
  leafHashes: string[]; // ordered by queryId ascending, exactly as anchored
  indexByQueryId: Map<string, number>;
  recomputedRoot: string;
}

/** Load every anchor batch the given ids refer to, once, with the leaf order needed to rebuild inclusion proofs. */
export async function loadAnchorContexts(prisma: PrismaClient, anchorIds: string[]): Promise<Map<string, AnchorContext>> {
  const out = new Map<string, AnchorContext>();
  const ids = [...new Set(anchorIds)];
  if (ids.length === 0) return out;
  const anchors = await prisma.screeningAnchor.findMany({ where: { id: { in: ids } } });
  for (const a of anchors) {
    const batch = await prisma.screeningReceipt.findMany({ where: { anchorId: a.id }, orderBy: { queryId: "asc" }, select: { queryId: true, leafHash: true } });
    const leafHashes = batch.map((b) => b.leafHash);
    out.set(a.id, {
      anchor: {
        id: a.id,
        canonVersion: a.canonVersion,
        merkleRoot: a.merkleRoot,
        leafCount: a.leafCount,
        txHash: a.txHash,
        ledgerIndex: a.ledgerIndex,
        closeTime: a.closeTime,
        anchoredAt: a.anchoredAt,
        account: a.account,
        memo: a.memo,
        status: a.status,
      },
      // A batch can mix canon versions; the memo type is the one the ANCHOR was written under.
      memoType: screenMemoTypeFor(a.canonVersion),
      leafHashes,
      indexByQueryId: new Map(batch.map((b, i) => [b.queryId, i])),
      recomputedRoot: merkleRootFromLeafHashes(leafHashes),
    });
  }
  return out;
}

export function proofFor(ctx: AnchorContext, queryId: string): { index: number; proof: ProofStep[] } {
  const index = ctx.indexByQueryId.get(queryId) ?? -1;
  return { index, proof: index >= 0 ? merkleInclusionProof(ctx.leafHashes, index) : [] };
}

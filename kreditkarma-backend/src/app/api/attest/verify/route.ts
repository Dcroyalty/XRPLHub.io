// src/app/api/attest/verify/route.ts
// GET /api/attest/verify?queryId=<uuid>
//
// Returns a screening receipt, its Merkle inclusion proof (rebuilt from the
// anchored batch), the on-ledger anchor tx + ledger close time, and the list
// snapshot hashes — everything an auditor needs to verify the receipt WITHOUT
// trusting XRPLHub. ?include=snapshot returns the full canonical list archive
// the screen ran against.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import {
  SCREEN_CANON_SPEC,
  canonScreenJson,
  screenLeafHash,
  merkleRootFromLeafHashes,
  merkleInclusionProof,
  renderStatement,
  type ScreenLeaf,
} from "@/lib/screenCanon";
import { SCREEN_MEMO_TYPE } from "@/lib/screenAnchor";
import { SCREEN_DISCLAIMER_SHORT } from "@/lib/screen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const queryId = url.searchParams.get("queryId");
  if (!queryId) {
    return NextResponse.json({ error: "bad_request", message: "queryId is required." }, { status: 400 });
  }

  const receipt = await prisma.screeningReceipt.findUnique({ where: { queryId } });
  if (!receipt) {
    return NextResponse.json(
      { error: "not_found", message: "No screening receipt with that queryId." },
      { status: 404 }
    );
  }

  const snap = await prisma.sanctionListSnapshot.findUnique({ where: { id: receipt.snapshotId } });

  if (url.searchParams.get("include") === "snapshot") {
    if (!snap) return NextResponse.json({ error: "not_found", message: "snapshot missing" }, { status: 404 });
    return NextResponse.json(
      {
        listName: snap.listName,
        vintage: snap.vintage,
        publishDate: snap.publishRaw,
        sha256: snap.sha256,
        recordCount: snap.recordCount,
        addressCount: snap.addressCount,
        source: snap.sourceUrl,
        fetchedAt: snap.fetchedAt.toISOString(),
        canonicalArchive: snap.canonicalArchive,
      },
      { headers: { "Cache-Control": "public, max-age=300" } }
    );
  }

  const lists = receipt.listsJson as unknown as ScreenLeaf["lists"];
  const result = receipt.resultJson as unknown as ScreenLeaf["result"];
  const leaf: ScreenLeaf = {
    queryId: receipt.queryId,
    subjectAddress: receipt.subjectAddress,
    requestedBy: receipt.requestedBy,
    lists,
    method: "exact-match",
    result,
    engineVersion: receipt.engineVersion,
    ledgerIndex: receipt.ledgerIndex,
    screenedAt: receipt.screenedAt.toISOString(),
  };
  const canonicalJson = canonScreenJson(leaf);
  const recomputedLeafHash = screenLeafHash(leaf);

  const base = {
    queryId,
    canonVersion: receipt.canonVersion,
    engineVersion: receipt.engineVersion,
    receipt: {
      subjectAddress: receipt.subjectAddress,
      requestedBy: receipt.requestedBy,
      screenedAt: leaf.screenedAt,
      method: "exact-match" as const,
      ledgerIndex: receipt.ledgerIndex,
      lists,
      result,
    },
    statement: renderStatement(leaf),
    leaf: {
      canonicalJson,
      leafHash: recomputedLeafHash,
      storedLeafHash: receipt.leafHash,
      leafHashMatches: recomputedLeafHash === receipt.leafHash,
    },
    listSnapshot: snap
      ? {
          listName: snap.listName,
          vintage: snap.vintage,
          publishDate: snap.publishRaw,
          sha256: snap.sha256,
          recordCount: snap.recordCount,
          addressCount: snap.addressCount,
          source: snap.sourceUrl,
          fetchedAt: snap.fetchedAt.toISOString(),
          archive: `https://www.xrplhub.io/api/attest/verify?queryId=${queryId}&include=snapshot`,
        }
      : null,
    canonicalisation: SCREEN_CANON_SPEC,
    disclaimer: SCREEN_DISCLAIMER_SHORT,
  };

  if (!receipt.anchorId) {
    return NextResponse.json(
      {
        ...base,
        status: "pending",
        anchor: null,
        note:
          "This receipt is recorded but not yet anchored on-ledger. The daily Merkle anchor will include it — " +
          "check back after the next run (or an operator can trigger POST /api/attest/anchor).",
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  const anchor = await prisma.screeningAnchor.findUnique({ where: { id: receipt.anchorId } });
  const batch = await prisma.screeningReceipt.findMany({
    where: { anchorId: receipt.anchorId },
    orderBy: { queryId: "asc" },
    select: { queryId: true, leafHash: true },
  });
  const idx = batch.findIndex((b) => b.queryId === queryId);
  const leafHashes = batch.map((b) => b.leafHash);
  const proof = idx >= 0 ? merkleInclusionProof(leafHashes, idx) : [];
  const recomputedRoot = merkleRootFromLeafHashes(leafHashes);

  return NextResponse.json(
    {
      ...base,
      status: anchor?.status === "anchored" ? "anchored" : anchor?.status ?? "unknown",
      anchor: anchor
        ? {
            merkleRoot: anchor.merkleRoot,
            recomputedRoot,
            rootMatches: recomputedRoot === anchor.merkleRoot,
            inclusionProof: proof,
            batchLeafCount: anchor.leafCount,
            leafIndex: idx,
            txHash: anchor.txHash,
            ledgerIndex: anchor.ledgerIndex,
            ledgerCloseTime: anchor.closeTime ? anchor.closeTime.toISOString() : null,
            anchoredAt: anchor.anchoredAt ? anchor.anchoredAt.toISOString() : null,
            account: anchor.account,
            memoType: SCREEN_MEMO_TYPE,
            memo: anchor.memo,
            explorer: anchor.txHash ? `https://livenet.xrpl.org/transactions/${anchor.txHash}` : null,
          }
        : null,
      recipe: [
        "1. Rebuild the leaf JSON from `receipt` using the key order in canonicalisation.record.keys. Sort `lists` by name; if result.listed, sort `matches` by [list, entryId]. JSON.stringify, no whitespace.",
        "2. leafHash = SHA-256( 0x00 || utf8(leafJson) ). It must equal `leaf.leafHash`.",
        "3. Fold `anchor.inclusionProof` from that leaf hash: for each step, h = SHA-256( 0x01 || (step.position=='left' ? step.hash||h : h||step.hash) ).",
        "4. The folded result must equal `anchor.merkleRoot`.",
        "5. Fetch tx `anchor.txHash` from any XRPL node / explorer. It must be an AccountSet from `anchor.account`; decode its MemoData from hex; the JSON's `root` must equal `anchor.merkleRoot` and its MemoType hex must decode to " + SCREEN_MEMO_TYPE + ".",
        "6. Re-obtain OFAC SDN publication " + (lists[0]?.vintage ?? "<vintage>") + ", canonicalise it the same way (see listSnapshot.archive for our stored copy + canonicalisation.engine), and confirm its SHA-256 equals `listSnapshot.sha256`.",
      ],
    },
    { headers: { "Cache-Control": "public, max-age=30" } }
  );
}

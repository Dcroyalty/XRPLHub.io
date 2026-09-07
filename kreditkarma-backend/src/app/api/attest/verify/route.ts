// src/app/api/attest/verify/route.ts
// GET /api/attest/verify?queryId=<uuid>
//
// Product-aware. A queryId is either an OFAC screening receipt or an XLS-66
// lending-exposure snapshot. Either way this returns the canonical leaf, its
// Merkle inclusion proof (rebuilt from the anchored batch), the on-ledger anchor
// tx + ledger close time, and the source data hash — everything an auditor needs
// to verify WITHOUT trusting XRPLHub.
//   ?include=snapshot  — screening: the full canonical OFAC list archive.

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
import { LENDING_CANON_SPEC, canonLendingLeaf, lendingLeafHash, type LendingExposureLeaf } from "@/lib/lendingCanon";
import { LENDING_MEMO_TYPE } from "@/lib/lendingAnchor";
import { LENDING_DISCLAIMER } from "@/lib/lendingExposure";
import { UNDERWRITE_CANON_SPEC, canonUnderwriteLeaf, underwriteLeafHash, UNDERWRITE_DISCLAIMER, type UnderwriteLeaf } from "@/lib/underwriteCanon";
import { UNDERWRITE_MEMO_TYPE } from "@/lib/underwriteAnchor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const queryId = url.searchParams.get("queryId");
  if (!queryId) {
    return NextResponse.json({ error: "bad_request", message: "queryId is required." }, { status: 400 });
  }

  const screening = await prisma.screeningReceipt.findUnique({ where: { queryId } });
  if (screening) return verifyScreening(queryId, url);

  const lending = await prisma.lendingExposureSnapshot.findUnique({ where: { queryId } });
  if (lending) return verifyLending(queryId);

  const bundle = await prisma.underwriteBundleReceipt.findUnique({ where: { queryId } });
  if (bundle) return verifyUnderwrite(queryId);

  return NextResponse.json(
    { error: "not_found", message: "No screening, lending-exposure, or underwrite-bundle record with that queryId." },
    { status: 404 }
  );
}

// ── OFAC screening ───────────────────────────────────────────────────────────
async function verifyScreening(queryId: string, url: URL) {
  const receipt = (await prisma.screeningReceipt.findUnique({ where: { queryId } }))!;
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
    product: "ofac-screening",
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
        note: "Recorded but not yet anchored on-ledger. The daily Merkle anchor will include it.",
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
      anchor: anchorBlock(anchor, recomputedRoot, proof, idx, SCREEN_MEMO_TYPE),
      recipe: [
        "1. Rebuild the leaf JSON from `receipt` using canonicalisation.record.keys order (sort `lists` by name; if result.listed, sort `matches` by [list, entryId]). No whitespace.",
        "2. leafHash = SHA-256( 0x00 || utf8(leafJson) ) — must equal `leaf.leafHash`.",
        "3. Fold `anchor.inclusionProof`: h = SHA-256( 0x01 || (step.position=='left' ? step.hash||h : h||step.hash) ).",
        "4. The result must equal `anchor.merkleRoot`.",
        "5. Fetch tx `anchor.txHash`; it is an AccountSet from `anchor.account`; decode MemoData from hex; its `root` must equal `anchor.merkleRoot`, MemoType hex must decode to " + SCREEN_MEMO_TYPE + ".",
        "6. Re-obtain OFAC SDN publication " + (lists[0]?.vintage ?? "<vintage>") + " and confirm its SHA-256 equals `listSnapshot.sha256`.",
      ],
    },
    { headers: { "Cache-Control": "public, max-age=30" } }
  );
}

// ── XLS-66 lending exposure ──────────────────────────────────────────────────
async function verifyLending(queryId: string) {
  const s = (await prisma.lendingExposureSnapshot.findUnique({ where: { queryId } }))!;

  const leaf: LendingExposureLeaf = {
    queryId: s.queryId,
    borrower: s.borrower,
    ledgerIndex: s.ledgerIndex,
    ledgerCloseAt: s.ledgerCloseAt ? s.ledgerCloseAt.toISOString() : null,
    amendmentActive: s.amendmentActive,
    exposureByAsset: s.exposureByAsset as unknown as LendingExposureLeaf["exposureByAsset"],
    loanCount: s.loanCount,
    brokerCount: s.brokerCount,
    events: s.events as unknown as LendingExposureLeaf["events"],
    worstStatus: s.worstStatus,
    visibleLoanIds: s.visibleLoanIds as unknown as string[],
    xrplScore: s.xrplScore,
    engineVersion: s.engineVersion,
    generatedAt: s.observedAt.toISOString(),
  };
  const canonicalJson = canonLendingLeaf(leaf);
  const recomputedLeafHash = lendingLeafHash(leaf);

  const base = {
    product: "lending-exposure",
    queryId,
    canonVersion: s.canonVersion,
    engineVersion: s.engineVersion,
    snapshot: {
      borrower: s.borrower,
      requestedBy: s.requestedBy,
      observedAt: leaf.generatedAt,
      ledgerIndex: s.ledgerIndex,
      ledgerCloseAt: leaf.ledgerCloseAt,
      amendmentActive: s.amendmentActive,
      loanCount: s.loanCount,
      brokerCount: s.brokerCount,
      worstStatus: s.worstStatus,
      exposureByAsset: leaf.exposureByAsset,
      events: leaf.events,
      visibleLoanIds: leaf.visibleLoanIds,
      xrplScore: s.xrplScore,
    },
    leaf: {
      canonicalJson,
      leafHash: recomputedLeafHash,
      storedLeafHash: s.leafHash,
      leafHashMatches: recomputedLeafHash === s.leafHash,
    },
    canonicalisation: LENDING_CANON_SPEC,
    disclaimer: LENDING_DISCLAIMER,
  };

  if (!s.anchorId) {
    return NextResponse.json(
      {
        ...base,
        status: "pending",
        anchor: null,
        note:
          "This exposure snapshot is recorded but not yet anchored on-ledger. The daily Merkle anchor will include it. " +
          "The snapshot itself (visibleLoanIds and all) is immutable from the moment it was written.",
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  const anchor = await prisma.lendingExposureAnchor.findUnique({ where: { id: s.anchorId } });
  const batch = await prisma.lendingExposureSnapshot.findMany({
    where: { anchorId: s.anchorId },
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
      anchor: anchorBlock(anchor, recomputedRoot, proof, idx, LENDING_MEMO_TYPE),
      recipe: [
        "1. Rebuild the leaf JSON from `snapshot` using canonicalisation.record.keys order (sort exposureByAsset keys and visibleLoanIds ascending). JSON.stringify, no whitespace.",
        "2. leafHash = SHA-256( 0x00 || utf8(leafJson) ) — must equal `leaf.leafHash`.",
        "3. Fold `anchor.inclusionProof`: h = SHA-256( 0x01 || (step.position=='left' ? step.hash||h : h||step.hash) ).",
        "4. The result must equal `anchor.merkleRoot`.",
        "5. Fetch tx `anchor.txHash`; it is an AccountSet from `anchor.account`; decode MemoData from hex; its `root` must equal `anchor.merkleRoot`, MemoType hex must decode to " + LENDING_MEMO_TYPE + ".",
        "6. `snapshot.visibleLoanIds` is the exact set of Loan objects that were on the ledger at `snapshot.ledgerIndex` — a loan later deleted is still provably attested here.",
      ],
    },
    { headers: { "Cache-Control": "public, max-age=30" } }
  );
}

// ── Underwriting-inputs bundle ───────────────────────────────────────────────
async function verifyUnderwrite(queryId: string) {
  const b = (await prisma.underwriteBundleReceipt.findUnique({ where: { queryId } }))!;
  const leaf = b.leafJson as unknown as UnderwriteLeaf;
  const canonicalJson = canonUnderwriteLeaf(leaf);
  const recomputedLeafHash = underwriteLeafHash(leaf);

  const base = {
    product: "underwrite-bundle",
    queryId,
    canonVersion: b.canonVersion,
    engineVersion: b.engineVersion,
    bundle: {
      borrower: b.borrower,
      requestedBy: b.requestedBy,
      observedAt: b.createdAt.toISOString(),
      ledgerIndex: b.ledgerIndex,
      xrplScore: b.xrplScore,
      screeningListed: b.screeningListed,
      worstStatus: b.worstStatus,
      components: {
        exposureQueryId: b.exposureQueryId,
        screeningQueryId: b.screeningQueryId,
        exposureLeafHash: leaf.exposureLeafHash,
        screeningLeafHash: leaf.screeningLeafHash || null,
      },
      leaf,
    },
    componentVerify: {
      exposure: `https://www.xrplhub.io/api/attest/verify?queryId=${b.exposureQueryId}`,
      screening: b.screeningQueryId ? `https://www.xrplhub.io/api/attest/verify?queryId=${b.screeningQueryId}` : null,
    },
    leaf: {
      canonicalJson,
      leafHash: recomputedLeafHash,
      storedLeafHash: b.leafHash,
      leafHashMatches: recomputedLeafHash === b.leafHash,
    },
    canonicalisation: UNDERWRITE_CANON_SPEC,
    disclaimer: UNDERWRITE_DISCLAIMER,
  };

  if (!b.anchorId) {
    return NextResponse.json(
      { ...base, status: "pending", anchor: null, note: "Recorded but not yet anchored on-ledger. The daily Merkle anchor will include it." },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  const anchor = await prisma.underwriteBundleAnchor.findUnique({ where: { id: b.anchorId } });
  const batch = await prisma.underwriteBundleReceipt.findMany({
    where: { anchorId: b.anchorId },
    orderBy: { queryId: "asc" },
    select: { queryId: true, leafHash: true },
  });
  const idx = batch.findIndex((r) => r.queryId === queryId);
  const leafHashes = batch.map((r) => r.leafHash);
  const proof = idx >= 0 ? merkleInclusionProof(leafHashes, idx) : [];
  const recomputedRoot = merkleRootFromLeafHashes(leafHashes);

  return NextResponse.json(
    {
      ...base,
      status: anchor?.status === "anchored" ? "anchored" : anchor?.status ?? "unknown",
      anchor: anchorBlock(anchor, recomputedRoot, proof, idx, UNDERWRITE_MEMO_TYPE),
      recipe: [
        "1. Rebuild the leaf JSON from `bundle.leaf` using canonicalisation.record.keys order. JSON.stringify, no whitespace.",
        "2. leafHash = SHA-256( 0x00 || utf8(leafJson) ) — must equal `leaf.leafHash`.",
        "3. Fold `anchor.inclusionProof`; the result must equal `anchor.merkleRoot`, which must be the `root` in tx `anchor.txHash` MemoData (MemoType " + UNDERWRITE_MEMO_TYPE + ").",
        "4. The bundle commits to the component leaf hashes. Verify each component separately: componentVerify.exposure and componentVerify.screening.",
      ],
    },
    { headers: { "Cache-Control": "public, max-age=30" } }
  );
}

function anchorBlock(
  anchor: { merkleRoot: string; leafCount: number; txHash: string | null; ledgerIndex: number | null; closeTime: Date | null; anchoredAt: Date | null; account: string | null; memo: string } | null,
  recomputedRoot: string,
  proof: Array<{ position: "left" | "right"; hash: string }>,
  idx: number,
  memoType: string
) {
  if (!anchor) return null;
  return {
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
    memoType,
    memo: anchor.memo,
    explorer: anchor.txHash ? `https://livenet.xrpl.org/transactions/${anchor.txHash}` : null,
  };
}

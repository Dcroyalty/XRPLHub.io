// src/app/api/attest/verify/route.ts
// GET /api/attest/verify?queryId=<uuid>
//
// Product-aware. A queryId is an OFAC screening receipt, an XLS-66 lending-exposure snapshot,
// an underwrite bundle, or a continuous-monitoring observation. Either way this returns the canonical leaf, its
// Merkle inclusion proof (rebuilt from the anchored batch), the on-ledger anchor
// tx + ledger close time, and the source data hash — everything an auditor needs
// to verify WITHOUT trusting XRPLHub.
//   ?include=snapshot&list=<NAME>  — screening: the full canonical archive of one list the receipt used (default: its first list).

import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { screenCanonSpecFor } from "@/lib/screenCanon";
import { merkleInclusionProof, merkleRootFromLeafHashes } from "@/lib/merkle";
import { SCREEN_DISCLAIMER_SHORT } from "@/lib/screen";
import { rebuildReceipt, loadAnchorContexts, proofFor } from "@/lib/screenRebuild";
import { LIMITATIONS, RETENTION_VIEW } from "@/lib/screenView";
import { LENDING_CANON_SPEC, canonLendingLeaf, lendingLeafHash, type LendingExposureLeaf } from "@/lib/lendingCanon";
import { LENDING_MEMO_TYPE } from "@/lib/lendingAnchor";
import { LENDING_DISCLAIMER } from "@/lib/lendingExposure";
import { UNDERWRITE_CANON_SPEC, canonUnderwriteLeaf, underwriteLeafHash, UNDERWRITE_DISCLAIMER, type UnderwriteLeaf } from "@/lib/underwriteCanon";
import { UNDERWRITE_MEMO_TYPE } from "@/lib/underwriteAnchor";
import { MONITOR_CANON_SPEC, MONITOR_DISCLAIMER, MONITOR_MEMO_TYPE, canonMonitorJson, monitorLeafHash, type MonitorLeaf } from "@/lib/monitorCanon";

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

  const observation = await prisma.monitorObservation.findUnique({ where: { observationId: queryId } });
  if (observation) return verifyMonitor(queryId);

  return NextResponse.json(
    { error: "not_found", message: "No screening, lending-exposure, underwrite-bundle, or monitoring-observation record with that queryId." },
    { status: 404 }
  );
}

// ── Sanctions screening (canon v1 = OFAC only, v2 = multi-list / multi-chain) ───────────────────────────
async function verifyScreening(queryId: string, url: URL) {
  const receipt = (await prisma.screeningReceipt.findUnique({ where: { queryId } }))!;
  const lists = receipt.listsJson as unknown as Array<{ name: string; vintage: string; sha256: string; chainAddressCount?: number }>;

  const snapshotFor = (name: string, sha256: string) =>
    prisma.sanctionListSnapshot.findFirst({ where: { listName: name, sha256 }, orderBy: { fetchedAt: "asc" } });
  const snapView = (snap: NonNullable<Awaited<ReturnType<typeof snapshotFor>>>) => ({
    listName: snap.listName,
    vintage: snap.vintage,
    publishDate: snap.publishRaw,
    sha256: snap.sha256,
    recordCount: snap.recordCount,
    addressCount: snap.addressCount,
    source: snap.sourceUrl,
    fetchedAt: snap.fetchedAt.toISOString(),
    archiveVersion: snap.archiveVersion,
    coverage: snap.coverageJson ?? null,
  });

  if (url.searchParams.get("include") === "snapshot") {
    const want = url.searchParams.get("list") ?? lists[0]?.name;
    const ref = lists.find((l) => l.name === want);
    const snap = ref ? await snapshotFor(ref.name, ref.sha256) : null;
    if (!snap) return NextResponse.json({ error: "not_found", message: `This receipt did not use a list named ${want ?? "(none)"}. It used: ${lists.map((l) => l.name).join(", ")}.` }, { status: 404 });
    return NextResponse.json({ ...snapView(snap), canonicalArchive: snap.canonicalArchive }, { headers: { "Cache-Control": "public, max-age=300" } });
  }

  const rb = rebuildReceipt(receipt);
  const listSnapshots = [];
  for (const l of lists) {
    const snap = await snapshotFor(l.name, l.sha256);
    listSnapshots.push({
      ...(snap ? snapView(snap) : { listName: l.name, vintage: l.vintage, sha256: l.sha256, note: "snapshot row not found" }),
      archive: `https://www.xrplhub.io/api/attest/verify?queryId=${queryId}&include=snapshot&list=${encodeURIComponent(l.name)}`,
    });
  }

  const base = {
    product: receipt.canonVersion === "ofac-screen-v1" ? "ofac-screening" : "sanctions-screening",
    queryId,
    canonVersion: receipt.canonVersion,
    engineVersion: receipt.engineVersion,
    receipt: {
      subjectAddress: receipt.subjectAddress,
      subjectChain: receipt.subjectChain,
      reference: receipt.reference,
      requestedBy: receipt.requestedBy,
      batchId: receipt.batchId,
      screenedAt: rb.leaf.screenedAt,
      method: "exact-match" as const,
      ledgerIndex: receipt.ledgerIndex,
      retention: receipt.retentionCode,
      lists,
      result: receipt.resultJson,
    },
    statement: rb.statement,
    leaf: { canonicalJson: rb.canonicalJson, leafHash: rb.recomputedLeafHash, storedLeafHash: receipt.leafHash, leafHashMatches: rb.leafHashMatches },
    listSnapshots,
    // kept for callers of the v1 shape: the first list's snapshot
    listSnapshot: listSnapshots[0] ?? null,
    canonicalisation: screenCanonSpecFor(receipt.canonVersion),
    retention: RETENTION_VIEW,
    limitations: LIMITATIONS,
    disclaimer: SCREEN_DISCLAIMER_SHORT,
  };

  if (!receipt.anchorId) {
    return NextResponse.json({ ...base, status: "pending", anchor: null, note: "Recorded but not yet anchored on-ledger. The daily Merkle anchor will include it." }, { headers: { "Cache-Control": "no-store" } });
  }

  const ctxs = await loadAnchorContexts(prisma, [receipt.anchorId]);
  const ctx = ctxs.get(receipt.anchorId);
  const { index, proof } = ctx ? proofFor(ctx, queryId) : { index: -1, proof: [] };
  const memoType = ctx?.memoType ?? "";

  return NextResponse.json(
    {
      ...base,
      status: ctx?.anchor.status === "anchored" ? "anchored" : ctx?.anchor.status ?? "unknown",
      anchor: ctx ? anchorBlock(ctx.anchor, ctx.recomputedRoot, proof, index, memoType) : null,
      recipe: [
        "1. Rebuild the leaf JSON from `receipt` using canonicalisation.record.keys order (sort `lists` by name; if result.listed, sort `matches` by [list, entryId]). No whitespace.",
        "2. leafHash = SHA-256( 0x00 || utf8(leafJson) ) — must equal `leaf.leafHash`.",
        "3. Fold `anchor.inclusionProof`: h = SHA-256( 0x01 || (step.position=='left' ? step.hash||h : h||step.hash) ).",
        "4. The result must equal `anchor.merkleRoot`.",
        "5. Fetch tx `anchor.txHash`; it is an AccountSet from `anchor.account`; decode MemoData from hex; its `root` must equal `anchor.merkleRoot`, MemoType hex must decode to " + memoType + ".",
        "6. For every entry of `listSnapshots`, re-obtain that list's publication for the stated vintage and confirm its SHA-256 equals `sha256` (or fetch the archive we retained).",
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

// ── Continuous-monitoring observation ────────────────────────────────────────
async function verifyMonitor(queryId: string) {
  const o = (await prisma.monitorObservation.findUnique({ where: { observationId: queryId } }))!;
  const leaf = o.recordJson as unknown as MonitorLeaf;
  const canonicalJson = canonMonitorJson(leaf);
  const recomputedLeafHash = monitorLeafHash(leaf);

  const base = {
    product: "monitoring-observation",
    queryId,
    canonVersion: o.canonVersion,
    engineVersion: o.engineVersion,
    observation: leaf,
    leaf: { canonicalJson, leafHash: recomputedLeafHash, storedLeafHash: o.leafHash, leafHashMatches: recomputedLeafHash === o.leafHash },
    canonicalisation: MONITOR_CANON_SPEC,
    disclaimer: MONITOR_DISCLAIMER,
  };

  if (!o.anchorId) {
    return NextResponse.json(
      { ...base, status: "pending", anchor: null, note: "Recorded but not yet anchored on-ledger. The daily Merkle anchor will include it. The observation itself is immutable from the moment it was written." },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  const anchor = await prisma.monitorAnchor.findUnique({ where: { id: o.anchorId } });
  const batch = await prisma.monitorObservation.findMany({ where: { anchorId: o.anchorId }, orderBy: { observationId: "asc" }, select: { observationId: true, leafHash: true } });
  const idx = batch.findIndex((b) => b.observationId === queryId);
  const leafHashes = batch.map((b) => b.leafHash);
  const proof = idx >= 0 ? merkleInclusionProof(leafHashes, idx) : [];
  const recomputedRoot = merkleRootFromLeafHashes(leafHashes);
  return NextResponse.json(
    {
      ...base,
      status: anchor?.status === "anchored" ? "anchored" : anchor?.status ?? "unknown",
      anchor: anchorBlock(anchor, recomputedRoot, proof, idx, MONITOR_MEMO_TYPE),
      recipe: [
        "1. Rebuild the leaf JSON from `observation` using canonicalisation.record.keys order (eventTypes sorted). JSON.stringify, no whitespace.",
        "2. leafHash = SHA-256( 0x00 || utf8(leafJson) ) — must equal `leaf.leafHash`.",
        "3. Fold `anchor.inclusionProof`: h = SHA-256( 0x01 || (step.position=='left' ? step.hash||h : h||step.hash) ).",
        "4. The result must equal `anchor.merkleRoot`.",
        "5. Fetch tx `anchor.txHash`; it is an AccountSet from `anchor.account`; decode MemoData from hex; its `root` must equal `anchor.merkleRoot`, MemoType hex must decode to " + MONITOR_MEMO_TYPE + ".",
        "6. A non-null `observation.xrplScore` was computed fresh during this observation; a null score with scoreStatus 'not_rescored' points at `scoreObservationRef` instead of repeating a stale number.",
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

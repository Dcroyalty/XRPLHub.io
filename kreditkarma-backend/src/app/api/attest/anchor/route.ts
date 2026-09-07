// src/app/api/attest/anchor/route.ts
// GET  /api/attest/anchor — the published canonicalisation spec for OFAC
//   screening receipts, the latest on-ledger anchor, and pipeline health.
//   Mirrors GET /api/mpt/anchor.
// POST /api/attest/anchor (admin) — refresh the SDN snapshot and anchor any
//   unanchored receipts NOW. ?force=1 skips the ~20h interval gate.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { isAdmin, adminUnauthorized } from "@/lib/adminAuth";
import {
  SCREEN_CANON_SPEC,
  SCREEN_CANON_VERSION,
  SCREEN_ENGINE_VERSION,
} from "@/lib/screenCanon";
import { SCREEN_MEMO_TYPE, maybeAnchorScreeningReceipts } from "@/lib/screenAnchor";
import { anchorSigningKeyPresent } from "@/lib/anchorMemo";
import { refreshSdnSnapshot, OFAC_SDN_LIST_NAME } from "@/lib/ofac";
import { ANCHOR_ACCOUNT } from "@/lib/mptAnchor";
import { EXPECTED_ISSUER } from "@/lib/credentials";
import { SCREEN_DISCLAIMER_SHORT } from "@/lib/screen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MEMO_TYPE_HEX = Buffer.from(SCREEN_MEMO_TYPE, "utf8").toString("hex").toUpperCase();

function anchorView(a: NonNullable<Awaited<ReturnType<typeof prisma.screeningAnchor.findFirst>>>) {
  return {
    canonVersion: a.canonVersion,
    merkleRoot: a.merkleRoot,
    leafCount: a.leafCount,
    rangeStart: a.rangeStart ? a.rangeStart.toISOString() : null,
    rangeEnd: a.rangeEnd ? a.rangeEnd.toISOString() : null,
    status: a.status,
    txHash: a.txHash,
    ledgerIndex: a.ledgerIndex,
    ledgerCloseTime: a.closeTime ? a.closeTime.toISOString() : null,
    account: a.account,
    feeDrops: a.feeDrops,
    memo: a.memo,
    anchoredAt: a.anchoredAt ? a.anchoredAt.toISOString() : null,
    createdAt: a.createdAt.toISOString(),
    error: a.error,
    explorer: a.txHash ? `https://livenet.xrpl.org/transactions/${a.txHash}` : null,
  };
}

export async function GET() {
  const [latest, lastFailure, lastAttempt, totalReceipts, unanchored, anchoredCount, snap] = await Promise.all([
    prisma.screeningAnchor.findFirst({ where: { status: "anchored" }, orderBy: { createdAt: "desc" } }),
    prisma.screeningAnchor.findFirst({
      where: { status: { in: ["failed", "misconfigured"] } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.screeningAnchor.findFirst({ orderBy: { createdAt: "desc" } }),
    prisma.screeningReceipt.count(),
    prisma.screeningReceipt.count({ where: { anchorId: null } }),
    prisma.screeningAnchor.count({ where: { status: "anchored" } }),
    prisma.sanctionListSnapshot.findFirst({
      where: { listName: OFAC_SDN_LIST_NAME },
      orderBy: { fetchedAt: "desc" },
    }),
  ]);

  const signingKeyPresent = anchorSigningKeyPresent();
  const lastFailureNewer =
    !!lastFailure && (!latest || lastFailure.createdAt > latest.createdAt);

  let status: "ok" | "misconfigured" | "failing" | "pending" | "no-snapshot";
  let message: string;
  if (!snap) {
    status = "no-snapshot";
    message =
      "No OFAC SDN snapshot ingested yet — screening is not ready. An operator can POST /api/attest/anchor, " +
      "or wait for the daily cron.";
  } else if (lastFailureNewer && lastFailure) {
    status = lastFailure.status === "misconfigured" ? "misconfigured" : "failing";
    message =
      `The most recent screening-anchor attempt ${lastFailure.status} at ${lastFailure.createdAt.toISOString()}: ` +
      `${lastFailure.error ?? "no detail"}.`;
  } else if (!latest && unanchored > 0) {
    status = "pending";
    message = `${unanchored} receipt(s) recorded, awaiting the first on-ledger anchor.`;
  } else {
    status = "ok";
    message = latest
      ? `Last anchored ${latest.anchoredAt?.toISOString() ?? latest.createdAt.toISOString()} at ledger ${latest.ledgerIndex}.`
      : "No receipts yet.";
  }

  return NextResponse.json(
    {
      product: "OFAC SDN screening attestation",
      status,
      message,
      disclaimer: SCREEN_DISCLAIMER_SHORT,
      terms: "https://www.xrplhub.io/legal/screening",

      engine: {
        version: SCREEN_ENGINE_VERSION,
        rules: SCREEN_CANON_SPEC.engine,
        versionBumpPolicy:
          "engineVersion is immutable per receipt. It is bumped (v2, v3, …) in the same commit as any change " +
          "to address normalisation, match semantics, which idType(s) are extracted, which list(s) are compared, " +
          "or which snapshot is selected. Ingesting a newer SDN snapshot is NOT a bump — that is `vintage`.",
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
          }
        : null,

      anchorAccount: ANCHOR_ACCOUNT,
      isNotTheCredentialIssuer: EXPECTED_ISSUER,
      health: {
        signingKeyPresent,
        totalReceipts,
        unanchoredReceipts: unanchored,
        anchoredBatches: anchoredCount,
        lastAttempt: lastAttempt ? anchorView(lastAttempt) : null,
        lastFailure: lastFailure ? anchorView(lastFailure) : null,
      },

      latest: latest ? anchorView(latest) : null,

      verify: {
        endpoint: "/api/attest/verify?queryId=<uuid>",
        summary:
          "Rebuild the receipt leaf, fold its inclusion proof to the Merkle root, confirm that root is in the " +
          "MemoData of the anchor tx, and confirm the cited SDN snapshot hash by re-fetching that OFAC publication.",
        canonicalisation: SCREEN_CANON_SPEC,
        onLedger: {
          account: ANCHOR_ACCOUNT,
          accountNote: SCREEN_CANON_SPEC.onLedger.accountNote,
          transactionType: "AccountSet",
          memoType: SCREEN_MEMO_TYPE,
          memoTypeHex: MEMO_TYPE_HEX,
          memoFormat: "application/json",
          memoDataIs: SCREEN_CANON_SPEC.onLedger.memoDataIs,
        },
      },
    },
    { headers: { "Cache-Control": "public, max-age=60" } }
  );
}

export async function POST(req: Request) {
  if (!isAdmin(req)) return adminUnauthorized();
  const force = new URL(req.url).searchParams.get("force") === "1";

  const sdn = await refreshSdnSnapshot(prisma);
  const anchor = await maybeAnchorScreeningReceipts(prisma, { force });

  return NextResponse.json({ sdn, anchor, forced: force });
}

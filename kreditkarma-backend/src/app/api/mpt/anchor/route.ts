// src/app/api/mpt/anchor/route.ts
// GET /api/mpt/anchor — the latest on-ledger anchor of the MPT registry, so a
// third party can prove the published registry hasn't been altered.
//
// BIS Working Paper 1374 pattern: after a cron pass, the registry index is
// canonicalised, a Merkle root is computed over the issuance records, and that
// root is committed in a Memo on a transaction from the issuer wallet. This
// endpoint returns the latest root + its tx hash + ledger index + record
// counts, plus the exact canonicalisation and Merkle scheme so the root can
// be reproduced from the published /api/mpt/search + /api/mpt/issuer data.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { CANON_SPEC, CANON_VERSION } from "@/lib/mptAnchor";
import { EXPECTED_ISSUER } from "@/lib/credentials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const MEMO_TYPE = `XRPLHub-MPT-Registry-Anchor/${CANON_VERSION}`;

function view(a: NonNullable<Awaited<ReturnType<typeof prisma.mptAnchor.findFirst>>>) {
  return {
    canonVersion: a.canonVersion,
    merkleRoot: a.merkleRoot,
    issuanceCount: a.issuanceCount,
    issuerCount: a.issuerCount,
    coverage: a.coverage,
    freshnessFloorAt: a.freshnessFloorAt ? a.freshnessFloorAt.toISOString() : null,
    status: a.status,
    txHash: a.txHash,
    ledgerIndex: a.ledgerIndex,
    account: a.account,
    feeDrops: a.feeDrops,
    memo: a.memo, // the exact UTF-8 payload written on-ledger (MemoData is this, hex-encoded)
    anchoredAt: a.anchoredAt ? a.anchoredAt.toISOString() : null,
    createdAt: a.createdAt.toISOString(),
    error: a.error,
    explorer: a.txHash ? `https://livenet.xrpl.org/transactions/${a.txHash}` : null,
  };
}

export async function GET() {
  const [latestAnchored, pending, total, anchoredCount] = await Promise.all([
    prisma.mptAnchor.findFirst({ where: { status: "anchored" }, orderBy: { createdAt: "desc" } }),
    prisma.mptAnchor.findFirst({ where: { status: "pending" }, orderBy: { createdAt: "desc" } }),
    prisma.mptAnchor.count(),
    prisma.mptAnchor.count({ where: { status: "anchored" } }),
  ]);

  const anchoringEnabled = process.env.MPT_ANCHOR_ENABLED === "true";
  const pendingDiffers = !!pending && pending.merkleRoot !== latestAnchored?.merkleRoot;

  return NextResponse.json({
    anchoringEnabled,
    latest: latestAnchored ? view(latestAnchored) : null,
    pendingNext: pendingDiffers ? view(pending) : null,
    history: { totalSnapshots: total, anchoredOnLedger: anchoredCount },
    verify: {
      summary:
        "Recompute the Merkle root from the published registry rows and check it equals `latest.merkleRoot`, " +
        "then confirm that root appears in the Memo of the transaction at `latest.txHash`.",
      registrySource: {
        note:
          "The rows are the union of every issuer's issuances. Enumerate the known issuers (each row's `issuer` " +
          "field across /api/mpt/search results, or ask us for the list), then GET /api/mpt/issuer?address=<issuer> " +
          "for each to get that issuer's complete set. Every issuance object is a registry row.",
        endpoints: ["/api/mpt/search?q=<issuer|id|name>", "/api/mpt/issuer?address=<issuer>"],
      },
      canonicalisation: CANON_SPEC,
      onLedger: {
        account: EXPECTED_ISSUER,
        transactionType: "AccountSet",
        memoType: MEMO_TYPE,
        memoTypeHex: Buffer.from(MEMO_TYPE, "utf8").toString("hex").toUpperCase(),
        memoFormat: "application/json",
        memoDataIs: "hex(UTF-8 JSON) — decode MemoData from hex to get `latest.memo`; its `root` field is the Merkle root.",
      },
      coverageMeaning:
        "`coverage` in the memo and here is 'complete-per-known-issuer' or 'partial'. It is NOT total-ledger " +
        "completeness — see GET /api/mpt/search `doesNotGuarantee`. A 'partial' anchor still carries the issuer " +
        "and issuance counts so the snapshot it commits to is unambiguous.",
    },
  }, { headers: { "Cache-Control": "public, max-age=60" } });
}

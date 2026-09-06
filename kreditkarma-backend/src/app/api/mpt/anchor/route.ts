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
  const [latestAnchored, pending, lastAttempt, lastFailure, total, anchoredCount] = await Promise.all([
    prisma.mptAnchor.findFirst({ where: { status: "anchored" }, orderBy: { createdAt: "desc" } }),
    prisma.mptAnchor.findFirst({ where: { status: "pending" }, orderBy: { createdAt: "desc" } }),
    prisma.mptAnchor.findFirst({ orderBy: { createdAt: "desc" } }),
    prisma.mptAnchor.findFirst({ where: { status: { in: ["failed", "misconfigured"] } }, orderBy: { createdAt: "desc" } }),
    prisma.mptAnchor.count(),
    prisma.mptAnchor.count({ where: { status: "anchored" } }),
  ]);

  const anchoringEnabled = process.env.MPT_ANCHOR_ENABLED === "true";
  const signingKeyPresent = !!process.env.CREDENTIAL_ISSUER_SEED;
  const misconfigured = anchoringEnabled && !signingKeyPresent;
  const pendingDiffers = !!pending && pending.merkleRoot !== latestAnchored?.merkleRoot;

  // Headline: if the last thing that happened was a failure/misconfig, or the
  // config itself is broken, say so first — a failed row must never read as
  // "nothing happened".
  const lastFailureNewerThanAnchor =
    !!lastFailure && (!latestAnchored || lastFailure.createdAt > latestAnchored.createdAt);
  let status: "ok" | "misconfigured" | "failing" | "pending" | "disabled";
  let message: string;
  if (misconfigured) {
    status = "misconfigured";
    message =
      "ANCHORING IS ENABLED (MPT_ANCHOR_ENABLED=true) BUT THE SIGNING KEY (CREDENTIAL_ISSUER_SEED) IS NOT SET. " +
      "No anchor can be produced on any run until the key is added to the environment.";
  } else if (lastFailureNewerThanAnchor && lastFailure) {
    status = "failing";
    message =
      `The most recent anchor attempt ${lastFailure.status === "misconfigured" ? "hit a configuration error" : "failed"} ` +
      `at ${lastFailure.createdAt.toISOString()}: ${lastFailure.error ?? "no detail"}. ` +
      `${lastFailure.status === "misconfigured" ? "It will keep failing the same way until the config is fixed." : "It may clear on the next run."}`;
  } else if (!anchoringEnabled) {
    status = "disabled";
    message = "Anchoring is disabled (MPT_ANCHOR_ENABLED not set). Snapshots are recorded but no tx is submitted.";
  } else if (!latestAnchored && pending) {
    status = "pending";
    message = "Anchoring is enabled; a snapshot is recorded and awaiting its first on-ledger anchor.";
  } else {
    status = "ok";
    message = latestAnchored
      ? `Last anchored ${latestAnchored.anchoredAt?.toISOString() ?? latestAnchored.createdAt.toISOString()} at ledger ${latestAnchored.ledgerIndex}.`
      : "No anchor yet.";
  }

  return NextResponse.json({
    status,
    message,
    health: {
      anchoringEnabled,
      signingKeyPresent,
      misconfigured,
      lastAttempt: lastAttempt ? view(lastAttempt) : null,
      lastFailure: lastFailure ? view(lastFailure) : null,
    },
    anchoringEnabled,
    latest: latestAnchored ? view(latestAnchored) : null,
    pendingNext: pendingDiffers ? view(pending) : null,
    history: {
      totalSnapshots: total,
      anchoredOnLedger: anchoredCount,
      failed: await prisma.mptAnchor.count({ where: { status: { in: ["failed", "misconfigured"] } } }),
    },
    verify: {
      summary:
        "Recompute the Merkle root from the published registry rows and check it equals `latest.merkleRoot`, " +
        "then confirm that root appears (as the `root` field of the JSON in MemoData) on the transaction at " +
        "`latest.txHash`.",
      recipe: [
        "1. Get the known issuer list: the distinct `issuer` values across GET /api/mpt/search results (paginate by issuer), or request the list.",
        "2. For each issuer, GET /api/mpt/issuer?address=<issuer> and take every object in `mpts` — that is one registry row.",
        "3. For each row build the canonical record (see `canonicalisation.record.keys`): metadataSha256 = lowercase hex SHA-256 of the row's `metadata` string (null if `metadata` is null); `flags` = the row's `flags`; `transferFee` = the row's `transferFee`; `sources` sorted ascending.",
        "4. JSON.stringify each record with the keys in the exact listed order, no whitespace. Sort the strings by issuanceId ascending.",
        "5. Merkle: leaf = SHA-256(0x00 || utf8(recordJson)); node = SHA-256(0x01 || left || right); odd node promoted; root is 64-hex lowercase.",
        "6. It must equal latest.merkleRoot, and decoding latest.txHash's MemoData from hex must yield JSON whose `root` is that value.",
      ],
      registrySource: {
        endpoints: ["/api/mpt/search?q=<issuer|id|name>", "/api/mpt/issuer?address=<issuer>"],
        rowFields:
          "Both endpoints expose every field the canonicalisation reads: issuanceId, issuer, sequence, " +
          "assetScale, maximumAmount, outstandingAmount, transferFee, flags, metadata, name, ticker, " +
          "holderCount, sources. (issuerPowers and transferFeeBps are human-friendly derivations — don't use them for the root.)",
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

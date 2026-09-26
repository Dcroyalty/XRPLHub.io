// src/app/api/attest/export/route.ts
// GET /api/attest/export?from=<date|ISO>&to=<date|ISO>[&format=json|csv][&limit=500][&cursor=…]
//
// The auditor export: every screening receipt THIS API KEY produced in a date range — its single and batch screens, and the receipts
// its continuous-monitoring subscriptions wrote — each with the exact list versions it used, its canonical leaf and hash, its Merkle
// inclusion proof and the on-ledger anchor transaction. Built so a compliance officer can hand it to an auditor, who can verify every
// line WITHOUT trusting XRPLHub: rebuild the leaf, fold the proof, compare to the root, compare to the memo in the anchor transaction.
//
//   from   inclusive. A bare date (2026-09-01) means 00:00:00Z that day.
//   to     exclusive. A bare date means 00:00:00Z of that day, so `to=2026-10-01` covers all of September. Default: now.
//   range  at most 366 days per request (page through longer periods).
//   format json (default) | csv. CSV is one row per receipt; the proof is a JSON string in its own column.
//   limit  1–1000 (default 500). Paginated by a cursor: pass `nextCursor` (JSON) / the X-Next-Cursor header (CSV) back as `cursor`.
//
// Receipts not yet anchored (recorded in the last day) are included with anchor: null and status "pending" — they are still receipts;
// they gain their proof after the next daily anchor. The export never drops, edits or summarises a receipt. Receipts are retained for at
// least 10 years and never pruned (see /legal/screening#retention); this export is how you keep your own copy.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { extractKey, resolveApiKey } from "@/lib/keys";
import { rebuildReceipt, loadAnchorContexts, proofFor } from "@/lib/screenRebuild";
import { SCREEN_CANON_SPEC_V2, screenCanonSpecFor } from "@/lib/screenCanon";
import { LIMITATIONS, RETENTION_VIEW, VERIFY_BASE } from "@/lib/screenView";
import { SCREEN_DISCLAIMER_SHORT } from "@/lib/screen";
import { verifyInclusion } from "@/lib/merkle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_RANGE_DAYS = 366;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;

function parseInstant(v: string | null, fallback: Date): Date | null {
  if (!v) return fallback;
  const s = v.trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00.000Z`) : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function encodeCursor(at: Date, queryId: string): string {
  return Buffer.from(`${at.toISOString()}|${queryId}`, "utf8").toString("base64url");
}
function decodeCursor(c: string | null): { at: Date; queryId: string } | null {
  if (!c) return null;
  try {
    const [iso, queryId] = Buffer.from(c, "base64url").toString("utf8").split("|");
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) || !queryId ? null : { at, queryId };
  } catch {
    return null;
  }
}

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
  // Neutralise spreadsheet formula injection (a cell that starts with = + - @ is executed by Excel): prefix with a single quote.
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return /[",\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
};

const CSV_COLUMNS = [
  "queryId", "screenedAt", "subjectChain", "subjectAddress", "reference", "requestedBy", "batchId", "listed", "matchedLists", "matches",
  "lists", "engineVersion", "canonVersion", "retention", "leafHash", "leafHashMatches", "anchorStatus", "anchorTxHash", "anchorLedgerIndex",
  "anchorCloseTime", "merkleRoot", "leafIndex", "batchLeafCount", "inclusionProofValid", "inclusionProof", "statement", "verifyUrl",
] as const;

export async function GET(req: Request) {
  const r = await resolveApiKey(extractKey(req));
  if (!r.ok) {
    if (r.reason === "expired") {
      return NextResponse.json({ error: "key_expired", message: `This API key's term ended at ${r.expiredAt}. Your receipts remain retained; buy a key to export them.`, expiredAt: r.expiredAt, renew: { pricing: "https://www.xrplhub.io/pricing" } }, { status: 402 });
    }
    return NextResponse.json({ error: "unauthorized", message: "Missing or invalid API key. The export returns only the receipts produced by the key you present." }, { status: 401 });
  }

  const u = new URL(req.url).searchParams;
  const now = new Date();
  const to = parseInstant(u.get("to"), now);
  const from = parseInstant(u.get("from"), new Date((to ?? now).getTime() - 30 * 86_400_000));
  if (!from || !to) return NextResponse.json({ error: "bad_request", message: "from/to must be a date (2026-09-01) or an ISO timestamp." }, { status: 400 });
  if (to <= from) return NextResponse.json({ error: "bad_request", message: "`to` must be after `from`." }, { status: 400 });
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000) {
    return NextResponse.json({ error: "range_too_large", message: `At most ${MAX_RANGE_DAYS} days per request; request the period in slices.` }, { status: 400 });
  }
  const format = (u.get("format") ?? "json").toLowerCase();
  if (format !== "json" && format !== "csv") return NextResponse.json({ error: "bad_request", message: "format must be json or csv." }, { status: 400 });
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(u.get("limit")) || DEFAULT_LIMIT));
  const cursor = decodeCursor(u.get("cursor"));
  if (u.get("cursor") && !cursor) return NextResponse.json({ error: "bad_request", message: "cursor is not valid (pass the nextCursor from the previous page unchanged)." }, { status: 400 });

  // This key's receipts: its own screens, and the ones its monitoring subscriptions wrote.
  const requesters = [`key:${r.key.keyPrefix}`, `monitor:${r.key.id}`];
  const where = {
    requestedBy: { in: requesters },
    screenedAt: { gte: from, lt: to },
    ...(cursor ? { OR: [{ screenedAt: { gt: cursor.at } }, { screenedAt: cursor.at, queryId: { gt: cursor.queryId } }] } : {}),
  };
  const page = await prisma.screeningReceipt.findMany({ where, orderBy: [{ screenedAt: "asc" }, { queryId: "asc" }], take: limit + 1 });
  const more = page.length > limit;
  const rows = more ? page.slice(0, limit) : page;
  const nextCursor = more ? encodeCursor(rows[rows.length - 1].screenedAt, rows[rows.length - 1].queryId) : null;

  const contexts = await loadAnchorContexts(prisma, rows.flatMap((x) => (x.anchorId ? [x.anchorId] : [])));
  const listVersions = new Map<string, { name: string; vintage: string; sha256: string; archive: string }>();
  let mismatches = 0;

  const receipts = rows.map((row) => {
    const rb = rebuildReceipt(row);
    if (!rb.leafHashMatches) mismatches++;
    const lists = row.listsJson as Array<{ name: string; vintage: string; sha256: string; chainAddressCount?: number }>;
    for (const l of lists) {
      const k = `${l.name}|${l.sha256}`;
      if (!listVersions.has(k)) listVersions.set(k, { name: l.name, vintage: l.vintage, sha256: l.sha256, archive: `${VERIFY_BASE}${row.queryId}&include=snapshot&list=${encodeURIComponent(l.name)}` });
    }
    const result = row.resultJson as { listed: boolean; matches?: Array<{ list: string; entryId: string; entryName: string; addressField: string }> };
    const ctx = row.anchorId ? contexts.get(row.anchorId) : undefined;
    let anchor: Record<string, unknown> | null = null;
    if (ctx) {
      const { index, proof } = proofFor(ctx, row.queryId);
      anchor = {
        status: ctx.anchor.status,
        txHash: ctx.anchor.txHash,
        ledgerIndex: ctx.anchor.ledgerIndex,
        ledgerCloseTime: ctx.anchor.closeTime ? ctx.anchor.closeTime.toISOString() : null,
        account: ctx.anchor.account,
        memoType: ctx.memoType,
        merkleRoot: ctx.anchor.merkleRoot,
        rootMatchesBatch: ctx.recomputedRoot === ctx.anchor.merkleRoot,
        batchLeafCount: ctx.anchor.leafCount,
        leafIndex: index,
        inclusionProof: proof,
        inclusionProofValid: index >= 0 && verifyInclusion(row.leafHash, proof, ctx.anchor.merkleRoot),
        explorer: ctx.anchor.txHash ? `https://livenet.xrpl.org/transactions/${ctx.anchor.txHash}` : null,
      };
    }
    return {
      queryId: row.queryId,
      screenedAt: rb.leaf.screenedAt,
      subjectChain: row.subjectChain,
      subjectAddress: row.subjectAddress,
      reference: row.reference,
      requestedBy: row.requestedBy,
      batchId: row.batchId,
      lists,
      result,
      statement: rb.statement,
      engineVersion: row.engineVersion,
      canonVersion: row.canonVersion,
      retention: row.retentionCode,
      canonicalLeaf: rb.canonicalJson,
      leafHash: row.leafHash,
      leafHashMatches: rb.leafHashMatches,
      status: anchor ? (anchor.status === "anchored" ? "anchored" : String(anchor.status)) : "pending",
      anchor,
      verify: `${VERIFY_BASE}${row.queryId}`,
    };
  });

  if (format === "csv") {
    const lines = [CSV_COLUMNS.join(",")];
    for (const x of receipts) {
      const a = x.anchor as { status?: string; txHash?: string; ledgerIndex?: number; ledgerCloseTime?: string; merkleRoot?: string; leafIndex?: number; batchLeafCount?: number; inclusionProofValid?: boolean; inclusionProof?: unknown } | null;
      const matches = x.result.listed ? x.result.matches ?? [] : [];
      lines.push(
        [
          x.queryId, x.screenedAt, x.subjectChain, x.subjectAddress, x.reference, x.requestedBy, x.batchId,
          x.result.listed, [...new Set(matches.map((m) => m.list))].join(";"), matches,
          x.lists.map((l) => `${l.name}@${l.vintage}#${l.sha256.slice(0, 12)}${l.chainAddressCount !== undefined ? `(${l.chainAddressCount})` : ""}`).join(";"),
          x.engineVersion, x.canonVersion, x.retention, x.leafHash, x.leafHashMatches,
          x.status, a?.txHash, a?.ledgerIndex, a?.ledgerCloseTime, a?.merkleRoot, a?.leafIndex, a?.batchLeafCount, a?.inclusionProofValid, a?.inclusionProof,
          x.statement, x.verify,
        ].map(csvCell).join(",")
      );
    }
    return new NextResponse(lines.join("\r\n") + "\r\n", {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="xrplhub-screening-export-${from.toISOString().slice(0, 10)}_${to.toISOString().slice(0, 10)}.csv"`,
        "Cache-Control": "no-store",
        "X-Export-Count": String(receipts.length),
        "X-Export-Api-Key-Prefix": r.key.keyPrefix,
        "X-Export-Retention": RETENTION_VIEW.code,
        ...(nextCursor ? { "X-Next-Cursor": nextCursor } : {}),
      },
    });
  }

  return NextResponse.json(
    {
      export: {
        formatVersion: "screening-export-v1",
        generatedAt: now.toISOString(),
        apiKeyPrefix: r.key.keyPrefix,
        includes: "receipts written by this key (its screens and its monitoring subscriptions'), every one in the range — none dropped, edited or summarised",
        range: { from: from.toISOString(), toExclusive: to.toISOString() },
        order: "screenedAt ascending, then queryId",
        count: receipts.length,
        nextCursor,
        leafHashMismatches: mismatches,
      },
      retention: RETENTION_VIEW,
      howToVerifyEachReceipt: [
        "1. Rebuild the canonical leaf from the receipt's fields using the canonicalisation for its canonVersion (GET /api/attest/anchor publishes both specs); it must equal `canonicalLeaf`.",
        "2. leafHash = SHA-256( 0x00 || utf8(canonicalLeaf) ) — must equal `leafHash`.",
        "3. Fold `anchor.inclusionProof` from the leaf: h = SHA-256( 0x01 || (step.position=='left' ? step.hash||h : h||step.hash) ). The result must equal `anchor.merkleRoot`.",
        "4. Fetch the XRPL transaction `anchor.txHash`: an AccountSet from `anchor.account`; decode its MemoData from hex; its `root` must equal `anchor.merkleRoot`; its MemoType must decode to `anchor.memoType`.",
        "5. For each list the receipt names: re-obtain that list's publication for the stated vintage and confirm its content hash against the archive (see listSnapshots[].archive).",
      ],
      canonicalisation: { current: SCREEN_CANON_SPEC_V2.version, specs: "https://www.xrplhub.io/api/attest/anchor", forThisPage: [...new Set(receipts.map((x) => x.canonVersion))].map((v) => screenCanonSpecFor(v).version) },
      listSnapshots: [...listVersions.values()],
      limitations: LIMITATIONS,
      disclaimer: SCREEN_DISCLAIMER_SHORT,
      receipts,
    },
    { headers: { "Cache-Control": "no-store", "X-Export-Count": String(receipts.length), ...(nextCursor ? { "X-Next-Cursor": nextCursor } : {}) } }
  );
}

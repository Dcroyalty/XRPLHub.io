// src/app/api/screen/batch/route.ts
// POST /api/screen/batch
//   { "addresses": [ "r...", { "address": "0x...", "reference": "transfer-123" }, … up to 100 ],
//     "lists": "OFAC-SDN,EU-FSF,UK-SL" (optional; default all) }
//
// Screens up to 100 addresses (XRP Ledger, EVM, Bitcoin, Tron — mixed is fine) in ONE call, against the same list snapshots, and
// returns ONE receipt PER ADDRESS. All receipts are stored in a single database transaction, so they land in the SAME on-ledger anchor
// batch, and they share a `batchId`. An address that is invalid on every supported chain is reported per item (no receipt, not
// counted); the rest are screened. Each valid address counts as one call against the monthly quota (a batch is one request for the
// per-minute limit). If the quota cannot cover the whole batch it is refused as a whole. Attests to process, not ground truth.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { extractKey, resolveApiKey } from "@/lib/keys";
import { guardUnits } from "@/lib/guard";
import { recogniseAddress } from "@/lib/chainAddress";
import { ListUnavailableError, parseListSelection, pinValidatedLedger, screenBatch, SCREEN_DISCLAIMER_SHORT } from "@/lib/screen";
import { LIMITATIONS, RETENTION_VIEW, receiptView } from "@/lib/screenView";
import { UNSUPPORTED_LISTS_NOTE } from "@/lib/sanctionLists";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const BATCH_MAX = 100;

export async function POST(req: Request) {
  const r = await resolveApiKey(extractKey(req));
  if (!r.ok) {
    if (r.reason === "expired") {
      return NextResponse.json({ error: "key_expired", message: `This API key's term ended at ${r.expiredAt}. Purchase a new key to continue.`, expiredAt: r.expiredAt, renew: { pricing: "https://www.xrplhub.io/pricing" } }, { status: 402 });
    }
    return NextResponse.json({ error: "unauthorized", message: "Missing or invalid API key. A free key works — see /pricing." }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as { addresses?: unknown; lists?: unknown } | null;
  if (!body || !Array.isArray(body.addresses) || body.addresses.length === 0) {
    return NextResponse.json({ error: "bad_request", message: "Send JSON { \"addresses\": [ ... ] } with 1–100 addresses (strings, or { address, reference })." }, { status: 400 });
  }
  if (body.addresses.length > BATCH_MAX) {
    return NextResponse.json({ error: "batch_too_large", message: `At most ${BATCH_MAX} addresses per call.`, batchMax: BATCH_MAX }, { status: 400 });
  }
  let lists;
  try {
    lists = parseListSelection(body.lists);
  } catch (e) {
    return NextResponse.json({ error: "bad_request", message: e instanceof Error ? e.message : "bad request" }, { status: 400 });
  }
  const items = body.addresses.map((a) => (a && typeof a === "object" && !Array.isArray(a) ? { address: (a as { address?: unknown }).address, reference: (a as { reference?: unknown }).reference } : { address: a, reference: undefined }));

  // Charge for what will actually be screened: the addresses that are valid on a supported chain.
  const validCount = items.filter((i) => recogniseAddress(i.address)).length;
  if (validCount > 0) {
    const g = await guardUnits(r.key.id, r.key.plan, validCount);
    if (!g.ok) {
      return NextResponse.json({ error: "rate_limited", message: g.reason, remaining: g.remaining }, { status: g.status, headers: g.retryAfterSeconds ? { "Retry-After": String(g.retryAfterSeconds) } : undefined });
    }
  }

  try {
    const ledgerIndex = await pinValidatedLedger();
    const b = await screenBatch(prisma, items, `key:${r.key.keyPrefix}`, ledgerIndex, { lists });
    return NextResponse.json(
      {
        batchId: b.batchId,
        screened: b.screened,
        invalid: b.invalid,
        listsUsed: b.listsUsed.map((l) => ({ name: l.name, vintage: l.vintage, sha256: l.sha256 })),
        anchoring: "All receipts in this batch were stored together and are included in the same daily Merkle anchor. Poll each receipt's verify URL, or export them with GET /api/attest/export.",
        results: b.results.map((x) => (x.status === "screened" ? { index: x.index, status: "screened", ...receiptView(x.outcome, { includeCanonical: false }) } : { index: x.index, status: "invalid", input: x.input, error: x.error })),
        limitations: LIMITATIONS,
        unlistedByDesign: UNSUPPORTED_LISTS_NOTE,
        retention: RETENTION_VIEW,
        disclaimer: SCREEN_DISCLAIMER_SHORT,
      },
      { headers: { "X-Batch-Id": b.batchId, "Cache-Control": "no-store" } }
    );
  } catch (err) {
    if (err instanceof ListUnavailableError) {
      return NextResponse.json({ error: "not_ready", message: err.message, unavailable: err.unavailable }, { status: 503, headers: { "Retry-After": "3600" } });
    }
    return NextResponse.json({ error: "screen_failed", message: err instanceof Error ? err.message : "batch failed" }, { status: 502 });
  }
}

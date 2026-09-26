// src/app/api/screen/route.ts
// GET /api/screen?address=...[&lists=OFAC-SDN,EU-FSF,UK-SL][&reference=<opaque id>]   (also POST { address, lists, reference })
//
// Compares ONE address (XRP Ledger, EVM, Bitcoin or Tron) against the current snapshot of EVERY sanctions list we hold that
// names crypto addresses — OFAC-SDN, EU-FSF, UK-SL — by exact address-string match on the address's own chain, and returns a
// factual, Merkle-anchored receipt that NAMES every list, its published version, its file hash and how many addresses it names
// on this chain. A "no match" is not a statement that the address is clean or unsanctioned. Not legal/compliance advice; it does
// not discharge the caller's screening or record-keeping obligations. See /legal/screening and GET /api/screen/lists.
//
// `reference` is the caller's own opaque id (e.g. a Travel Rule transfer id) stored in the attested leaf — never personal data.
// Auth: any active API key (the free tier works). Metered like a score call. Every screen — match OR no-match — writes a full
// receipt and lands in the next daily anchor batch. Fails closed: an unsupported/mistyped address is refused (400), and a list
// that is not ready makes the screen unavailable (503) rather than silently checking fewer lists.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { extractKey, resolveApiKey } from "@/lib/keys";
import { guard } from "@/lib/guard";
import { UNSUPPORTED_ADDRESS_MESSAGE, recogniseAddress } from "@/lib/chainAddress";
import { ListUnavailableError, UnsupportedAddressError, cleanReference, parseListSelection, screenAll } from "@/lib/screen";
import { fullReceiptResponse } from "@/lib/screenView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

const RENEW = { pricing: "https://www.xrplhub.io/pricing" };

async function handle(req: Request, input: { address: unknown; lists: unknown; reference: unknown }) {
  const r = await resolveApiKey(extractKey(req));
  if (!r.ok) {
    if (r.reason === "expired") {
      return NextResponse.json(
        { error: "key_expired", message: `This API key's term ended at ${r.expiredAt}. Purchase a new key to continue.`, expiredAt: r.expiredAt, renew: RENEW },
        { status: 402, headers: { "Cache-Control": "no-store" } }
      );
    }
    return NextResponse.json({ error: "unauthorized", message: "Missing or invalid API key. A free key works — see /pricing." }, { status: 401 });
  }

  const rec = recogniseAddress(input.address);
  if (!rec) return NextResponse.json({ error: "bad_request", message: UNSUPPORTED_ADDRESS_MESSAGE }, { status: 400 });
  let lists;
  let reference;
  try {
    lists = parseListSelection(input.lists);
    reference = cleanReference(input.reference);
  } catch (e) {
    return NextResponse.json({ error: "bad_request", message: e instanceof Error ? e.message : "bad request" }, { status: 400 });
  }

  const g = await guard(r.key.id, r.key.plan);
  if (!g.ok) {
    return NextResponse.json({ error: "rate_limited", message: g.reason }, { status: g.status, headers: g.retryAfterSeconds ? { "Retry-After": String(g.retryAfterSeconds) } : undefined });
  }

  try {
    const out = await screenAll(prisma, rec.address, `key:${r.key.keyPrefix}`, { lists, reference });
    return NextResponse.json(fullReceiptResponse(out), { headers: { "X-Attestation-Id": out.queryId, "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof ListUnavailableError) {
      return NextResponse.json({ error: "not_ready", message: err.message, unavailable: err.unavailable }, { status: 503, headers: { "Retry-After": "3600" } });
    }
    if (err instanceof UnsupportedAddressError) return NextResponse.json({ error: "bad_request", message: UNSUPPORTED_ADDRESS_MESSAGE }, { status: 400 });
    return NextResponse.json({ error: "screen_failed", message: err instanceof Error ? err.message : "screen failed" }, { status: 502 });
  }
}

export async function GET(req: Request) {
  const u = new URL(req.url).searchParams;
  return handle(req, { address: u.get("address"), lists: u.get("lists"), reference: u.get("reference") });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { address?: unknown; lists?: unknown; reference?: unknown };
  return handle(req, { address: body.address ?? null, lists: body.lists, reference: body.reference });
}

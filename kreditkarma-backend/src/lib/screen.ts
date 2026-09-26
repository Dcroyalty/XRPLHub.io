// src/lib/screen.ts
// Sanctions screening: an exact address-string comparison against the CURRENT snapshot of each requested list
// (OFAC-SDN, EU-FSF, UK-SL), on the subject's own chain. Produces a canonical receipt leaf per address, persists it, and
// returns the receipt. A receipt attests to PROCESS ONLY — see src/lib/screenCanon.ts. It never states or implies that an
// address is sanctioned, clean, safe, or risky, and it never says that using it satisfies any legal obligation.
//
// Fail closed, three ways:
//   • an address that is not on a supported chain, or whose checksum fails, is REFUSED (UnsupportedAddressError) — never "not listed";
//   • a list that has no snapshot, or whose snapshot did not extract the subject's chain, makes the screen UNAVAILABLE for that list
//     (ListUnavailableError -> HTTP 503) — never silently skipped;
//   • the receipt names EVERY list consulted, with its published version, file hash, and how many addresses it names on the
//     subject's chain (0 is reported as 0 — an XRP Ledger address checked against the EU list was checked against no XRPL address).

import { randomUUID } from "crypto";
import type { PrismaClient } from "@prisma/client";
import {
  SCREEN_CANON_VERSION,
  SCREEN_ENGINE_VERSION,
  SCREEN_RETENTION_CODE,
  canonScreenJsonV2,
  screenLeafHashV2,
  renderStatementV2,
  type ScreenLeafV2,
  type ScreenListRefV2,
  type ScreenMatch,
  type ScreenResult,
} from "./screenCanon";
import { LIST_CATALOG, LIST_NAMES, chainAddressCount, currentSnapshot, snapshotCovers, type ListName, type SnapshotRef } from "./sanctionLists";
import { recogniseAddress, type Chain, type RecognisedAddress } from "./chainAddress";
import { XRPL_NODES } from "./xrplscore";

export const SCREEN_DISCLAIMER_SHORT =
  "This receipt records one factual comparison: the address was checked against the sanctions list versions named above, at the " +
  'stated time. A "no match" means the address did not appear on those list versions — it is not a statement that the address is ' +
  "clean, safe, or unsanctioned. These lists are name/entity-based; address matching covers only the addresses they name. XRPLHub " +
  "is not a regulated entity, gives no legal or compliance advice, and makes no compliance decision. Using this receipt does not " +
  "satisfy or reduce your own screening, due-diligence or record-keeping obligations; you remain responsible for your compliance " +
  "program and for verifying any result. Full terms: https://www.xrplhub.io/legal/screening";

export class UnsupportedAddressError extends Error {
  readonly input: string;
  constructor(input: string) {
    super("Not a valid address on a supported chain (or its checksum does not verify).");
    this.name = "UnsupportedAddressError";
    this.input = input;
  }
}

export interface ListUnavailability {
  list: ListName;
  reason: "no_snapshot" | "chain_not_covered";
}

export class ListUnavailableError extends Error {
  readonly unavailable: ListUnavailability[];
  readonly chain: Chain;
  constructor(unavailable: ListUnavailability[], chain: Chain) {
    super(
      "Screening is not ready for " +
        unavailable.map((u) => `${u.list} (${u.reason === "no_snapshot" ? "no snapshot ingested yet" : `its snapshot does not yet cover ${chain} addresses`})`).join(", ") +
        ". Nothing was screened or recorded. You may screen against the lists that are ready by naming them explicitly (lists=…).",
    );
    this.name = "ListUnavailableError";
    this.unavailable = unavailable;
    this.chain = chain;
  }
}
/** Backwards-compatible name (routes catch this and answer 503 not_ready). */
export const NoSnapshotError = ListUnavailableError;

export interface ScreenOutcome {
  queryId: string;
  leaf: ScreenLeafV2;
  leafHash: string;
  canonicalJson: string;
  snapshotId: string;
  statement: string;
  subjectChain: Chain;
  /** Every list consulted, with the snapshot and how many addresses it names on the subject's chain. */
  listsUsed: Array<{ name: ListName; vintage: string; sha256: string; chainAddressCount: number; snapshotId: string }>;
}

export interface ScreenOptions {
  /** Default: every list. */
  lists?: ListName[];
  reference?: string | null;
  batchId?: string | null;
}

/** Validate a caller-supplied list selection. Throws Error(message) for an unknown name. */
export function parseListSelection(input: unknown): ListName[] {
  if (input === undefined || input === null || input === "") return [...LIST_NAMES];
  const raw = Array.isArray(input) ? input : String(input).split(",");
  const names = raw.map((x) => String(x).trim()).filter(Boolean);
  const out: ListName[] = [];
  for (const n of names) {
    const hit = LIST_NAMES.find((l) => l.toLowerCase() === n.toLowerCase());
    if (!hit) throw new Error(`Unknown list "${n.slice(0, 40)}". Known lists: ${LIST_NAMES.join(", ")}. (The UN consolidated list is not offered: it names no crypto addresses.)`);
    if (!out.includes(hit)) out.push(hit);
  }
  return out.length ? out : [...LIST_NAMES];
}

/** A caller reference is stored in the attested leaf, so keep it short and boring: an opaque id, never personal data. */
export function cleanReference(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s.length > 64 || !/^[A-Za-z0-9._:\-/#]+$/.test(s)) {
    throw new Error("reference must be 1–64 characters of letters, digits and . _ : - / # (an opaque id such as a transfer id — never a name or other personal data).");
  }
  return s;
}

const nowIso = () => new Date().toISOString(); // ms precision, 'Z'

// ── one or many addresses ─────────────────────────────────────────────────────
async function loadSnapshots(prisma: PrismaClient, lists: ListName[], chains: Set<Chain>): Promise<Map<ListName, SnapshotRef>> {
  const out = new Map<ListName, SnapshotRef>();
  const unavailable: ListUnavailability[] = [];
  for (const l of lists) {
    const snap = await currentSnapshot(prisma, l);
    if (!snap) {
      unavailable.push({ list: l, reason: "no_snapshot" });
      continue;
    }
    for (const c of chains) {
      if (!snapshotCovers(snap, c)) {
        unavailable.push({ list: l, reason: "chain_not_covered" });
        break;
      }
    }
    out.set(l, snap);
  }
  if (unavailable.length) throw new ListUnavailableError(unavailable, [...chains][0]);
  return out;
}

interface PreparedScreen {
  rec: RecognisedAddress;
  reference: string | null;
  outcome: ScreenOutcome;
}

/**
 * Compare every address to every requested list and BUILD (not store) the receipts. One query per list for the whole set.
 * All subjects share one screenedAt-independent snapshot selection so a batch is internally consistent.
 */
async function prepare(
  prisma: PrismaClient,
  subjects: Array<{ rec: RecognisedAddress; reference: string | null }>,
  requestedBy: string,
  ledgerIndex: number,
  lists: ListName[]
): Promise<PreparedScreen[]> {
  const chains = new Set(subjects.map((s) => s.rec.chain));
  const snaps = await loadSnapshots(prisma, lists, chains);

  // matches[list][chain:normalized] -> rows
  const hits = new Map<string, Array<{ entryId: string; entryName: string; addressField: string }>>();
  for (const l of lists) {
    const snap = snaps.get(l)!;
    for (const chain of chains) {
      const wanted = subjects.filter((s) => s.rec.chain === chain);
      if (snap.archiveVersion < 2) {
        // v1 snapshot: XRP addresses only, matched on the verbatim `address`
        const rows = await prisma.sanctionedAddress.findMany({ where: { snapshotId: snap.id, address: { in: wanted.map((w) => w.rec.address) } } });
        for (const r of rows) pushHit(hits, `${l}|${chain}|${r.address}`, r);
      } else {
        const rows = await prisma.sanctionedAddress.findMany({ where: { snapshotId: snap.id, chain, addressNorm: { in: wanted.map((w) => w.rec.normalized) } } });
        for (const r of rows) pushHit(hits, `${l}|${chain}|${r.addressNorm}`, r);
      }
    }
  }

  return subjects.map(({ rec, reference }) => {
    const matches: ScreenMatch[] = [];
    const refs: ScreenListRefV2[] = [];
    const used: ScreenOutcome["listsUsed"] = [];
    for (const l of lists) {
      const snap = snaps.get(l)!;
      const key = `${l}|${rec.chain}|${snap.archiveVersion < 2 ? rec.address : rec.normalized}`;
      for (const h of hits.get(key) ?? []) matches.push({ list: l, entryId: h.entryId, entryName: h.entryName, addressField: h.addressField });
      const n = chainAddressCount(snap, rec.chain);
      refs.push({ name: l, vintage: snap.vintage, sha256: snap.sha256, chainAddressCount: n });
      used.push({ name: l, vintage: snap.vintage, sha256: snap.sha256, chainAddressCount: n, snapshotId: snap.id });
    }
    const result: ScreenResult = matches.length ? { listed: true, matches } : { listed: false };
    const queryId = randomUUID();
    const leaf: ScreenLeafV2 = {
      queryId,
      subjectAddress: rec.address,
      subjectChain: rec.chain,
      reference,
      requestedBy,
      lists: refs,
      method: "exact-match",
      result,
      engineVersion: SCREEN_ENGINE_VERSION,
      retention: SCREEN_RETENTION_CODE,
      ledgerIndex,
      screenedAt: nowIso(),
    };
    return {
      rec,
      reference,
      outcome: {
        queryId,
        leaf,
        leafHash: screenLeafHashV2(leaf),
        canonicalJson: canonScreenJsonV2(leaf),
        snapshotId: used[0].snapshotId,
        statement: renderStatementV2(leaf),
        subjectChain: rec.chain,
        listsUsed: used,
      },
    };
  });
}

function pushHit(m: Map<string, Array<{ entryId: string; entryName: string; addressField: string }>>, key: string, r: { entryId: string; entryName: string; addressField: string }) {
  const arr = m.get(key) ?? [];
  arr.push({ entryId: r.entryId, entryName: r.entryName, addressField: r.addressField });
  m.set(key, arr);
}

function receiptRow(o: ScreenOutcome, batchId: string | null) {
  const l = o.leaf;
  return {
    queryId: o.queryId,
    subjectAddress: l.subjectAddress,
    subjectChain: l.subjectChain,
    reference: l.reference,
    requestedBy: l.requestedBy,
    screenedAt: new Date(l.screenedAt),
    method: l.method,
    ledgerIndex: l.ledgerIndex,
    listsJson: l.lists as unknown as object,
    resultJson: l.result as unknown as object,
    engineVersion: l.engineVersion,
    canonVersion: SCREEN_CANON_VERSION,
    retentionCode: l.retention,
    leafHash: o.leafHash,
    snapshotId: o.snapshotId,
    batchId,
  };
}

/** Screen ONE address (any supported chain) against the requested lists and store its receipt. */
export async function screenAddress(prisma: PrismaClient, rawAddress: string, requestedBy: string, ledgerIndex: number, opts: ScreenOptions = {}): Promise<ScreenOutcome> {
  const rec = recogniseAddress(rawAddress);
  if (!rec) throw new UnsupportedAddressError(String(rawAddress).slice(0, 60));
  const lists = opts.lists?.length ? opts.lists : [...LIST_NAMES];
  const [p] = await prepare(prisma, [{ rec, reference: cleanReference(opts.reference) }], requestedBy, ledgerIndex, lists);
  await prisma.screeningReceipt.create({ data: receiptRow(p.outcome, opts.batchId ?? null) });
  return p.outcome;
}

export interface BatchItemInput {
  address: unknown;
  reference?: unknown;
}
export type BatchItemResult =
  | { index: number; input: string; status: "screened"; outcome: ScreenOutcome }
  | { index: number; input: string; status: "invalid"; error: string };

/**
 * Screen up to 100 addresses in ONE call. Invalid addresses are reported per item (no receipt, not counted); every valid one gets
 * its own receipt, and ALL receipts are stored in a single transaction — so they land in the same anchor batch (the anchor job
 * collects unanchored receipts in one read; a transaction is all-or-nothing to that read).
 */
export async function screenBatch(
  prisma: PrismaClient,
  items: BatchItemInput[],
  requestedBy: string,
  ledgerIndex: number,
  opts: { lists?: ListName[] } = {}
): Promise<{ batchId: string; results: BatchItemResult[]; screened: number; invalid: number; listsUsed: ScreenOutcome["listsUsed"] }> {
  const lists = opts.lists?.length ? opts.lists : [...LIST_NAMES];
  const batchId = randomUUID();
  const results: BatchItemResult[] = new Array(items.length);
  const subjects: Array<{ rec: RecognisedAddress; reference: string | null; index: number; input: string }> = [];
  items.forEach((it, index) => {
    const input = String(it.address ?? "").slice(0, 100);
    const rec = recogniseAddress(it.address);
    if (!rec) {
      results[index] = { index, input, status: "invalid", error: "Not a valid address on a supported chain (or its checksum does not verify). Nothing was screened or recorded for it." };
      return;
    }
    let reference: string | null = null;
    try {
      reference = cleanReference(it.reference);
    } catch (e) {
      results[index] = { index, input, status: "invalid", error: e instanceof Error ? e.message : "bad reference" };
      return;
    }
    subjects.push({ rec, reference, index, input });
  });

  let listsUsed: ScreenOutcome["listsUsed"] = [];
  if (subjects.length) {
    const prepared = await prepare(prisma, subjects.map((s) => ({ rec: s.rec, reference: s.reference })), requestedBy, ledgerIndex, lists);
    await prisma.$transaction(
      async (tx) => {
        await tx.screeningReceipt.createMany({ data: prepared.map((p) => receiptRow(p.outcome, batchId)) });
      },
      { timeout: 30_000, maxWait: 10_000 }
    );
    prepared.forEach((p, i) => {
      results[subjects[i].index] = { index: subjects[i].index, input: subjects[i].input, status: "screened", outcome: p.outcome };
    });
    listsUsed = prepared[0].outcome.listsUsed;
  }
  return { batchId, results, screened: subjects.length, invalid: items.length - subjects.length, listsUsed };
}

/** Pin the current validated XRPL ledger index as a time anchor for a screen. Independent of whether the subject is an
 *  activated account. 0 on failure — the receipt records that honestly. */
export async function pinValidatedLedger(): Promise<number> {
  for (const url of XRPL_NODES) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "ledger", params: [{ ledger_index: "validated" }] }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) continue;
      const j = (await res.json()) as { result?: { ledger_index?: number; ledger?: { ledger_index?: number | string } } };
      const li = Number(j.result?.ledger_index ?? j.result?.ledger?.ledger_index ?? 0);
      if (Number.isFinite(li) && li > 0) return li;
    } catch {
      /* try next node */
    }
  }
  return 0;
}

/** Screen + pin the ledger in one call against EVERY list — the shape the unified API route wants. */
export async function screenAll(prisma: PrismaClient, rawAddress: string, requestedBy: string, opts: ScreenOptions = {}): Promise<ScreenOutcome> {
  return screenAddress(prisma, rawAddress, requestedBy, await pinValidatedLedger(), opts);
}

/** The OFAC-only entry point (kept for the /api/screen/ofac, x402 and MCP surfaces, which advertise OFAC SDN only). */
export async function screenOfac(prisma: PrismaClient, rawAddress: string, requestedBy: string): Promise<ScreenOutcome> {
  return screenAddress(prisma, rawAddress, requestedBy, await pinValidatedLedger(), { lists: ["OFAC-SDN"] });
}

/** Kept for callers that already hold a ledger index (the monitoring engine). OFAC only unless `lists` says otherwise. */
export async function runOfacScreen(prisma: PrismaClient, rawAddress: string, requestedBy: string, ledgerIndex: number, opts: ScreenOptions = {}): Promise<ScreenOutcome> {
  return screenAddress(prisma, rawAddress, requestedBy, ledgerIndex, { lists: ["OFAC-SDN"], ...opts });
}

// ── Discovery schemas (shared by the challenge, .well-known/x402, openapi) ─────

/** < 480 chars — mirrored into the 402 challenge and every discovery doc. */
export const SCREEN_OFAC_DESCRIPTION =
  "Compare one XRPL address against a vintage-pinned OFAC SDN snapshot (exact address-string match only). " +
  "Returns a factual, Merkle-anchored receipt: the list, its published version, the file SHA-256, and " +
  "whether the address appeared on it. 'No match' = not on that version, NOT a statement that the address " +
  "is clean or unsanctioned. Attests to process, not ground truth. Not legal/compliance advice; you keep " +
  "your screening obligations.";

export const SCREEN_OFAC_INPUT_SCHEMA = {
  type: "object",
  properties: {
    address: {
      type: "string",
      pattern: "^r[1-9A-HJ-NP-Za-km-z]{24,34}$",
      description: "XRPL classic address (r...) to compare against the OFAC SDN list.",
      example: "rnXyVQzgxZe7TR1EPzTkGj2jxH4LMJYh66",
    },
  },
  required: ["address"],
} as const;

const LIST_REF_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", enum: [...LIST_NAMES] },
    vintage: { type: "string", description: "The list's published version (ISO date) that was screened against." },
    sha256: { type: "string", description: "Hash of the canonical archive of that exact list snapshot — makes the snapshot reproducible." },
    chainAddressCount: { type: "integer", description: "How many addresses this list snapshot names on the subject's chain. 0 is meaningful (e.g. the EU list names no XRP Ledger address)." },
  },
} as const;

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    listed: {
      type: "boolean",
      description: "true = the address string is on at least one of the named list versions. false = it did not appear. false is NOT a statement that the address is clean, safe, or unsanctioned.",
    },
    matches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          list: { type: "string" },
          entryId: { type: "string", description: "The list's own entry id (OFAC SDN uid, EU reference, UK Unique ID)." },
          entryName: { type: "string", description: "The entry's own listed name (the publisher's fact)." },
          addressField: { type: "string", description: "Where the list names the address, e.g. 'Digital Currency Address - XRP', or the free-text element for EU/UK." },
        },
      },
    },
  },
  required: ["listed"],
} as const;

export const SCREEN_OFAC_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    attestation: {
      type: "object",
      properties: {
        queryId: { type: "string", description: "UUID. GET /api/attest/verify?queryId= for the Merkle inclusion proof once anchored." },
        canonVersion: { type: "string", enum: ["sanctions-screen-v2"] },
        engineVersion: { type: "string", enum: ["sanction-screen-v2"], description: "Immutable per receipt — the exact match algorithm." },
        leafHash: { type: "string", description: "64-hex SHA-256(0x00 || canonical leaf)." },
        verify: { type: "string" },
      },
    },
    subject: { type: "string" },
    subjectChain: { type: "string", enum: ["xrpl", "evm", "btc", "tron"] },
    screenedAt: { type: "string", format: "date-time" },
    method: { type: "string", enum: ["exact-match"] },
    ledgerIndex: { type: "integer", description: "Validated XRPL ledger pinned as a time anchor; 0 if unavailable." },
    lists: { type: "array", items: LIST_REF_SCHEMA },
    result: RESULT_SCHEMA,
    statement: { type: "string", description: "The one factual paragraph: compared X against list L at vintage V (names N addresses on this chain), and did / did not appear." },
    canonicalLeaf: { type: "string", description: "The exact JSON that was leaf-hashed." },
    retention: { type: "string", description: "The retention commitment in force at screening time (see /legal/screening)." },
    disclaimer: { type: "string" },
  },
  required: ["attestation", "subject", "screenedAt", "method", "lists", "result", "statement", "disclaimer"],
} as const;

export const SCREEN_OFAC_OUTPUT_EXAMPLE = {
  attestation: {
    queryId: "21e9db64-1cec-49e6-9891-3402bb40db5f",
    canonVersion: "sanctions-screen-v2",
    engineVersion: "sanction-screen-v2",
    leafHash: "cd890b5a640e37ae7e00983fd872f43daf7a88b52de3821d5bf1e23cb295c2a5",
    verify: "https://www.xrplhub.io/api/attest/verify?queryId=21e9db64-1cec-49e6-9891-3402bb40db5f",
  },
  subject: "rnXyVQzgxZe7TR1EPzTkGj2jxH4LMJYh66",
  subjectChain: "xrpl",
  screenedAt: "2026-09-07T06:08:41.368Z",
  method: "exact-match",
  ledgerIndex: 106817057,
  lists: [{ name: "OFAC-SDN", vintage: "2026-09-04", sha256: "97d98ef8f8273db9326e3e7beb4163d2d8a171f8a0d90fb628c488b53339d340", chainAddressCount: 1 }],
  result: {
    listed: true,
    matches: [{ list: "OFAC-SDN", entryId: "33854", entryName: "CHATEX", addressField: "Digital Currency Address - XRP" }],
  },
  statement:
    "As of 2026-09-07T06:08:41.368Z, XRP Ledger address rnXyVQzgxZe7TR1EPzTkGj2jxH4LMJYh66 was compared against: OFAC-SDN published version 2026-09-04 (file SHA-256 97d98ef8…d340; names 1 XRP Ledger address). It appears on: OFAC-SDN entry 33854 (CHATEX), field 'Digital Currency Address - XRP'.",
  canonicalLeaf: "{\"queryId\":\"21e9db64-…\",\"subjectAddress\":\"rnXyVQzgxZe7TR1EPzTkGj2jxH4LMJYh66\",\"subjectChain\":\"xrpl\",…}",
  retention: "retain-10y-no-prune/v1",
  disclaimer: SCREEN_DISCLAIMER_SHORT,
};

/** Public description of every list, for the API and the spec: what it is, who publishes it, what its address content really is. */
export function listCatalogView() {
  return LIST_NAMES.map((n) => {
    const i = LIST_CATALOG[n];
    return { name: i.name, title: i.title, publisher: i.publisher, jurisdiction: i.jurisdiction, source: i.sourceUrl, addressContent: i.addressContent };
  });
}

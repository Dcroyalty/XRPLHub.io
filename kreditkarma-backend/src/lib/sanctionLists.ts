// src/lib/sanctionLists.ts
// Vintaged, content-hashed, archive-forever ingestion for every sanctions list we screen against, with the integrity gates
// that refuse a suspiciously empty or truncated snapshot. One generic path for OFAC-SDN, EU-FSF and UK-SL.
//
// APPEND-ONLY: a snapshot (its canonical archive AND its address rows) is written once and never updated or deleted.
// A screening receipt names a list by (name, vintage, file SHA-256); the archive behind that hash is retained forever so any
// receipt can be re-checked against exactly the list version it used.
//
// Gates before a write (a garbled fetch that silently produced an empty list would make every screen say "not listed" —
// the one failure that turns this product into a liability):
//   0. Cheap: the source's own publish date is unchanged since the last snapshot        -> skip the download
//   1. The raw file is implausibly small                                                -> BLOCK
//   2. Entity/record count fell below 90% of the previous snapshot (truncated file)     -> BLOCK
//   3. Zero addresses where the previous snapshot had some                              -> BLOCK
//   4. Address count fell below 60% of the previous snapshot (previous had >= 10)       -> BLOCK
//   5. Content hash already stored                                                      -> unchanged
// A blocked refresh alerts and leaves the previous snapshot in force; screening keeps using it, and each receipt says which
// vintage it used.

import { createHash } from "crypto";
import type { PrismaClient } from "@prisma/client";
import { notifyError } from "./notify";
import type { Chain } from "./chainAddress";
import {
  EU_FSF_SOURCE,
  LIST_NAMES,
  OFAC_SDN_SOURCE,
  UK_SL_SOURCE,
  chainCounts,
  parseEuFsf,
  parseOfacSdn,
  parseUkSl,
  type ListName,
  type ParsedList,
} from "./sanctionParsers";

export { LIST_NAMES, type ListName } from "./sanctionParsers";

export interface ListInfo {
  name: ListName;
  title: string;
  publisher: string;
  jurisdiction: string;
  sourceUrl: string;
  /** What the list actually contains, in one honest sentence (shown in the API, the receipts' spec and the Terms). */
  addressContent: string;
  minBytes: number;
  minRecords: number;
  parse: (text: string) => ParsedList;
  /** Regex over the first ~8 KB of the source that yields its publication stamp, when it has one (skips the full download). */
  peekPattern?: RegExp;
}

export const LIST_CATALOG: Record<ListName, ListInfo> = {
  "OFAC-SDN": {
    name: "OFAC-SDN",
    title: "OFAC Specially Designated Nationals (SDN) list",
    publisher: "U.S. Department of the Treasury, OFAC",
    jurisdiction: "US",
    sourceUrl: OFAC_SDN_SOURCE,
    addressContent:
      "Structured: digital-currency addresses are typed identifiers (\"Digital Currency Address - <currency>\") on SDN entries, about 20 currencies. Screenable here: XRP Ledger, EVM, Bitcoin and Tron addresses; entries on other chains (LTC, XMR, DASH, ZEC, BCH, SOL, DOGE, …) are archived but a query on those chains is refused.",
    minBytes: 1_000_000,
    minRecords: 10_000,
    parse: parseOfacSdn,
    peekPattern: /<Publish_Date>([^<]+)<\/Publish_Date>/,
  },
  "EU-FSF": {
    name: "EU-FSF",
    title: "EU consolidated list of persons, groups and entities subject to EU financial sanctions",
    publisher: "European Commission (FISMA), Financial Sanctions Files",
    jurisdiction: "EU",
    sourceUrl: EU_FSF_SOURCE,
    addressContent:
      "Name/entity-based. Crypto addresses appear only as free text in a few <remark> fields (a handful of designations, e.g. Garantex); none is an XRP Ledger address. Address screening against this list is therefore partial by nature: it covers only the addresses the Council chose to write into a remark.",
    minBytes: 5_000_000,
    minRecords: 3_000,
    parse: parseEuFsf,
    peekPattern: /generationDate="([^"]+)"/,
  },
  "UK-SL": {
    name: "UK-SL",
    title: "UK Sanctions List (FCDO)",
    publisher: "UK Foreign, Commonwealth & Development Office (single source since 2026-01-28; the OFSI Consolidated List is closed)",
    jurisdiction: "UK",
    sourceUrl: UK_SL_SOURCE,
    addressContent:
      "Name/entity-based. Crypto addresses appear only as free text in OtherInformation / UKStatementofReasons for a few designations; none is an XRP Ledger address. Address screening against this list is therefore partial by nature.",
    minBytes: 5_000_000,
    minRecords: 3_000,
    parse: parseUkSl,
  },
};

/** The UN Security Council consolidated list is name/entity-based and contains no crypto addresses; it is NOT screened. */
export const UNSUPPORTED_LISTS_NOTE =
  "The UN Security Council consolidated list names no crypto addresses (name/entity-based), so it is not part of address screening and no receipt refers to it.";

// ── reading the current snapshots ─────────────────────────────────────────────
export interface SnapshotRef {
  id: string;
  listName: ListName;
  vintage: string;
  publishRaw: string;
  sha256: string;
  archiveVersion: number;
  recordCount: number;
  addressCount: number;
  /** chain -> number of addresses this snapshot holds for it. A v1 snapshot is XRP-only. */
  coverage: Record<string, number>;
  fetchedAt: Date;
  unparsedCount: number;
}

type SnapRow = {
  id: string;
  listName: string;
  vintage: string;
  publishRaw: string;
  sha256: string;
  archiveVersion: number;
  recordCount: number;
  addressCount: number;
  coverageJson: unknown;
  unparsedJson: unknown;
  fetchedAt: Date;
};

function toRef(r: SnapRow): SnapshotRef {
  const cov = (r.coverageJson && typeof r.coverageJson === "object" ? (r.coverageJson as Record<string, number>) : null) ?? (r.archiveVersion < 2 ? { xrpl: r.addressCount } : {});
  return {
    id: r.id,
    listName: r.listName as ListName,
    vintage: r.vintage,
    publishRaw: r.publishRaw,
    sha256: r.sha256,
    archiveVersion: r.archiveVersion,
    recordCount: r.recordCount,
    addressCount: r.addressCount,
    coverage: cov,
    fetchedAt: r.fetchedAt,
    unparsedCount: Array.isArray(r.unparsedJson) ? r.unparsedJson.length : 0,
  };
}

/**
 * The snapshot a screen runs against for one list: the newest v2 snapshot; failing that (OFAC only, until its first v2
 * ingestion) the newest v1 snapshot, which covers XRP Ledger addresses only.
 */
export async function currentSnapshot(prisma: PrismaClient, list: ListName): Promise<SnapshotRef | null> {
  const v2 = await prisma.sanctionListSnapshot.findFirst({ where: { listName: list, archiveVersion: { gte: 2 } }, orderBy: { fetchedAt: "desc" } });
  if (v2) return toRef(v2 as unknown as SnapRow);
  const v1 = await prisma.sanctionListSnapshot.findFirst({ where: { listName: list }, orderBy: { fetchedAt: "desc" } });
  return v1 ? toRef(v1 as unknown as SnapRow) : null;
}

/** Can this snapshot answer a query on `chain`? (A snapshot that never extracted a chain must never answer "not listed" for it.) */
export function snapshotCovers(s: SnapshotRef, chain: Chain): boolean {
  if (s.archiveVersion < 2) return chain === "xrpl";
  return s.coverage[chain] !== undefined; // present (even at 0 addresses) = that chain was extracted from this list
}

/** How many addresses on `chain` the snapshot names (0 is a meaningful, reportable number). */
export function chainAddressCount(s: SnapshotRef, chain: Chain): number {
  return s.coverage[chain] ?? 0;
}

// ── freshness bookkeeping (a list that legitimately does not change for days must not look stale) ──
const checkedId = (l: ListName) => `sanctions-checked:${l}`;

export async function markChecked(prisma: PrismaClient, list: ListName): Promise<void> {
  const now = new Date();
  await prisma.indexerCheckpoint.upsert({ where: { id: checkedId(list) }, create: { id: checkedId(list), lastCompletedPassAt: now }, update: { lastCompletedPassAt: now } }).catch(() => undefined);
}

export async function lastChecked(prisma: PrismaClient, list: ListName): Promise<Date | null> {
  const r = await prisma.indexerCheckpoint.findUnique({ where: { id: checkedId(list) } }).catch(() => null);
  return r?.lastCompletedPassAt ?? null;
}

// ── fetching ─────────────────────────────────────────────────────────────────
const sha256hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** Read only the head of a source to get its publication stamp without downloading it (Range; else read one chunk and stop). */
export async function peekStamp(url: string, pattern: RegExp): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { Range: "bytes=0-8191", accept: "application/xml" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok && res.status !== 206) return null;
    if (res.status === 206) return res.text().then((t) => t.match(pattern)?.[1]?.trim() ?? null);
    if (!res.body) return null;
    const reader = res.body.getReader();
    const { value } = await reader.read();
    await reader.cancel().catch(() => undefined);
    return new TextDecoder().decode(value ?? new Uint8Array()).match(pattern)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

async function fetchList(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(90_000), headers: { accept: "application/xml,text/xml,*/*" } });
  if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
  return res.text();
}

// ── canonical archive ────────────────────────────────────────────────────────
export interface CanonicalArchive {
  archiveVersion: 2;
  listName: ListName;
  vintage: string;
  publishRaw: string;
  recordCount: number;
  addressCount: number;
  coverage: Record<string, number>;
  sourceUrl: string;
  unparsed: ParsedList["unparsed"];
  addresses: ParsedList["entries"];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function canonicalise(p: ParsedList): { canonical: CanonicalArchive; sha256: string } {
  const addresses = [...p.entries].sort((a, b) => cmp(a.chain, b.chain) || cmp(a.normalized, b.normalized) || cmp(a.entryId, b.entryId) || cmp(a.addressField, b.addressField));
  const canonical: CanonicalArchive = {
    archiveVersion: 2,
    listName: p.listName,
    vintage: p.vintage,
    publishRaw: p.publishRaw,
    recordCount: p.recordCount,
    addressCount: addresses.length,
    // Every supported chain the parser EXTRACTS is declared, with 0 where the list names none: "covered, and the list names no address"
    // is different from "not extracted" (a snapshot that never looked at a chain must never answer "not listed" for it).
    coverage: { xrpl: 0, evm: 0, btc: 0, tron: 0, ...chainCounts(addresses) },
    sourceUrl: p.sourceUrl,
    unparsed: p.unparsed,
    addresses,
  };
  return { canonical, sha256: sha256hex(JSON.stringify(canonical)) };
}

// ── the refresh ──────────────────────────────────────────────────────────────
export interface RefreshResult {
  action: "written" | "unchanged" | "blocked-integrity" | "blocked-error";
  listName: ListName;
  vintage?: string;
  sha256?: string;
  addressCount?: number;
  coverage?: Record<string, number>;
  snapshotId?: string;
  unparsed?: number;
  detail: string;
}

export async function refreshList(prisma: PrismaClient, name: ListName, opts: { force?: boolean } = {}): Promise<RefreshResult> {
  const info = LIST_CATALOG[name];
  const prev = await prisma.sanctionListSnapshot.findFirst({ where: { listName: name, archiveVersion: { gte: 2 } }, orderBy: { fetchedAt: "desc" } });
  const prevAny = prev ?? (await prisma.sanctionListSnapshot.findFirst({ where: { listName: name }, orderBy: { fetchedAt: "desc" } }));

  // Gate 0: the source's own stamp is unchanged -> skip the download entirely. (Only against a v2 snapshot: the first v2
  // ingestion of OFAC must parse even though the v1 snapshot has the same publish date.)
  if (prev && info.peekPattern && !opts.force) {
    const peeked = await peekStamp(info.sourceUrl, info.peekPattern);
    if (peeked && peeked === prev.publishRaw) {
      await markChecked(prisma, name);
      return { action: "unchanged", listName: name, vintage: prev.vintage, sha256: prev.sha256, addressCount: prev.addressCount, snapshotId: prev.id, detail: `publication stamp unchanged (${prev.publishRaw}) — full download skipped` };
    }
  }

  let text: string;
  let parsed: ParsedList;
  try {
    text = await fetchList(info.sourceUrl);
    if (text.length < info.minBytes) throw new Error(`source suspiciously small (${text.length} bytes; expected >= ${info.minBytes}) — refusing to parse`);
    parsed = info.parse(text);
  } catch (err) {
    await notifyError(`sanction-lists/${name}`, err, { phase: "fetch/parse" });
    return { action: "blocked-error", listName: name, detail: err instanceof Error ? err.message : "fetch/parse failed" };
  }
  text = ""; // release the ~25-70 MB string before the write

  const { canonical, sha256 } = canonicalise(parsed);
  const block = async (msg: string): Promise<RefreshResult> => {
    await notifyError(`sanction-lists/${name}`, new Error(msg), { phase: "integrity-gate", fetchedVintage: canonical.vintage, addresses: canonical.addressCount, records: canonical.recordCount });
    return { action: "blocked-integrity", listName: name, vintage: canonical.vintage, addressCount: canonical.addressCount, detail: msg };
  };

  if (parsed.recordCount < info.minRecords) {
    return block(`${name}: parsed only ${parsed.recordCount} records (expected >= ${info.minRecords}) — looks truncated. Refusing to write; screening continues against the previous snapshot${prevAny ? ` (${prevAny.vintage})` : ""}.`);
  }
  if (prev && !opts.force) {
    if (parsed.recordCount < prev.recordCount * 0.9) {
      return block(`${name}: ${parsed.recordCount} records vs ${prev.recordCount} in the previous snapshot (${prev.vintage}) — a drop of more than 10% looks like a truncated fetch. Refusing to write.`);
    }
    if (canonical.addressCount === 0 && prev.addressCount > 0) {
      return block(`${name}: parse yielded 0 addresses but the previous snapshot (${prev.vintage}) had ${prev.addressCount}. Refusing to write — a list that silently emptied would make every screen say "not listed".`);
    }
    if (prev.addressCount >= 10 && canonical.addressCount < prev.addressCount * 0.6) {
      return block(`${name}: ${canonical.addressCount} addresses vs ${prev.addressCount} in the previous snapshot (${prev.vintage}) — a drop of more than 40% needs a human look. Refusing to write.`);
    }
  } else if (!prev && prevAny && prevAny.addressCount > 0 && canonical.addressCount === 0) {
    return block(`${name}: parse yielded 0 addresses but the last snapshot (${prevAny.vintage}) had ${prevAny.addressCount}. Refusing to write.`);
  }

  const dup = await prisma.sanctionListSnapshot.findFirst({ where: { listName: name, sha256 } });
  if (dup) {
    await markChecked(prisma, name);
    return { action: "unchanged", listName: name, vintage: dup.vintage, sha256, addressCount: dup.addressCount, snapshotId: dup.id, detail: "content hash already stored" };
  }

  // ONE transaction: the snapshot and every address row, or nothing. A snapshot committed without its rows would answer
  // "not listed" for everything, so the row count is verified inside the transaction and a mismatch rolls it back.
  const snap = await prisma.$transaction(
    async (tx) => {
      const s = await tx.sanctionListSnapshot.create({
        data: {
          listName: name,
          vintage: canonical.vintage,
          publishRaw: canonical.publishRaw,
          recordCount: canonical.recordCount,
          addressCount: canonical.addressCount,
          sha256,
          sourceUrl: canonical.sourceUrl,
          canonicalArchive: canonical as unknown as object,
          archiveVersion: 2,
          coverageJson: canonical.coverage as unknown as object,
          unparsedJson: canonical.unparsed as unknown as object,
        },
      });
      const rows = canonical.addresses.map((a) => ({
        snapshotId: s.id,
        listName: name,
        address: a.address,
        entryId: a.entryId,
        entryName: a.entryName,
        programs: a.programs,
        addressField: a.addressField,
        idUid: a.idUid,
        chain: a.chain,
        currency: a.currency,
        addressNorm: a.normalized,
      }));
      for (let i = 0; i < rows.length; i += 500) {
        await tx.sanctionedAddress.createMany({ data: rows.slice(i, i + 500) });
      }
      const stored = await tx.sanctionedAddress.count({ where: { snapshotId: s.id } });
      if (stored !== canonical.addressCount) throw new Error(`row count mismatch: stored ${stored}, expected ${canonical.addressCount} — rolled back`);
      return s;
    },
    { timeout: 50_000, maxWait: 10_000 }
  );
  await markChecked(prisma, name);
  await compactSuperseded(prisma, name, snap.id);
  if (canonical.unparsed.length > 0) {
    await notifyError(`sanction-lists/${name}`, new Error(`${canonical.unparsed.length} address-like text(s) on ${name} ${canonical.vintage} could not be verified as addresses (see the snapshot's unparsedJson). Screening is unaffected for verified addresses; review the unparsed text.`), { phase: "unparsed" });
  }
  return {
    action: "written",
    listName: name,
    vintage: canonical.vintage,
    sha256,
    addressCount: canonical.addressCount,
    coverage: canonical.coverage,
    snapshotId: snap.id,
    unparsed: canonical.unparsed.length,
    detail: `new snapshot ${canonical.vintage} — ${canonical.addressCount} address(es): ${JSON.stringify(canonical.coverage)}`,
  };
}

/**
 * Storage: a v2 snapshot's lookup rows (~1,000 for OFAC) are only ever READ for the CURRENT snapshot of a list; a superseded snapshot
 * is evidenced by its canonicalArchive (compressed, ~75 KB), which is kept forever with the snapshot row itself. The per-address
 * rows of a superseded snapshot are a derived index of that archive, so they are dropped once the snapshot is more than 6 h
 * superseded (the delay makes it impossible for an in-flight screen to find a snapshot whose rows have just gone). Nothing else is
 * ever deleted: no snapshot, archive or receipt. Without this OFAC's near-daily vintages cost ~0.6 MB/day of rows.
 * Best effort: a failure here only means the rows stay.
 */
export async function compactSuperseded(prisma: PrismaClient, name: ListName, keepSnapshotId: string): Promise<void> {
  try {
    await prisma.sanctionedAddress.deleteMany({
      where: { snapshotId: { not: keepSnapshotId }, snapshot: { listName: name, archiveVersion: 2, fetchedAt: { lt: new Date(Date.now() - 6 * 3_600_000) } } },
    });
  } catch {
    // leave the rows; the archive is the record
  }
}

/** Refresh every list, each only if `deadlineMs` still leaves room for it (a list not reached stays due for the next run). */
export async function refreshAllLists(prisma: PrismaClient, opts: { deadlineMs?: number; force?: boolean } = {}): Promise<RefreshResult[]> {
  const out: RefreshResult[] = [];
  for (const name of LIST_NAMES) {
    if (opts.deadlineMs && Date.now() > opts.deadlineMs) {
      out.push({ action: "blocked-error", listName: name, detail: "skipped: cron time budget — due again next run" });
      continue;
    }
    out.push(
      await refreshList(prisma, name, { force: opts.force }).catch(async (e) => {
        await notifyError(`sanction-lists/${name}`, e, { phase: "unexpected" });
        return { action: "blocked-error" as const, listName: name, detail: e instanceof Error ? e.message : "refresh threw" };
      })
    );
  }
  return out;
}

// src/lib/ofac.ts
// OFAC SDN list ingestion with vintaging + an integrity gate.
//
// Source: the OFAC Sanctions List Service SDN.xml. We extract ONLY XRP
// digital-currency addresses ("Digital Currency Address - XRP"), normalise into
// a canonical snapshot, content-hash it, and store it — APPEND-ONLY, forever.
//
// Two gates before a write:
//   1. Content hash unchanged since the last snapshot -> no-op.
//   2. INTEGRITY: the parse yielded 0 XRP addresses while the previous snapshot
//      had > 0 -> DO NOT WRITE. Alert instead. A truncated or garbled fetch
//      that silently produces an empty list would make every screen return
//      "not listed" and every receipt attest to nothing — the one failure that
//      turns this product into a liability.

import { createHash } from "crypto";
import type { PrismaClient } from "@prisma/client";
import { notifyError } from "./notify";

const SDN_XML_URL = "https://sanctionslistservice.ofac.treas.gov/api/download/sdn.xml";
export const OFAC_SDN_LIST_NAME = "OFAC-SDN";
const XRP_ID_TYPE = "Digital Currency Address - XRP";
const MIN_PLAUSIBLE_BYTES = 1_000_000;

export interface ExtractedAddress {
  address: string;
  entryId: string;
  entryName: string;
  programs: string;
  addressField: string;
  idUid: string;
}

export interface ParsedSdn {
  publishRaw: string;
  vintage: string; // ISO YYYY-MM-DD
  recordCount: number;
  addresses: ExtractedAddress[];
  xmlBytes: number;
}

function isoFromOfacDate(mdY: string): string {
  const m = mdY.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return mdY.trim();
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

const firstGroup = (re: RegExp, s: string): string | undefined => {
  const m = s.match(re);
  return m ? m[1] : undefined;
};

/** Cheap pre-check: read only the header to get Publish_Date without the ~29 MB
 *  body. Uses a Range request; if the server ignores Range (200, not 206), reads
 *  just the first chunk off the stream and cancels. Returns null if it can't do
 *  either cheaply — the caller then falls back to a full fetch. */
export async function peekPublishDate(): Promise<string | null> {
  const RE = /<Publish_Date>([^<]+)<\/Publish_Date>/;
  try {
    const res = await fetch(SDN_XML_URL, {
      headers: { Range: "bytes=0-8191", accept: "application/xml" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok && res.status !== 206) return null;
    if (res.status === 206) {
      return firstGroup(RE, await res.text())?.trim() ?? null;
    }
    // 200 — server ignored Range. Read one chunk, then stop.
    if (!res.body) return null;
    const reader = res.body.getReader();
    const { value } = await reader.read();
    await reader.cancel().catch(() => {});
    return firstGroup(RE, new TextDecoder().decode(value ?? new Uint8Array()))?.trim() ?? null;
  } catch {
    return null;
  }
}

export async function fetchAndParseSdn(): Promise<ParsedSdn> {
  const res = await fetch(SDN_XML_URL, {
    signal: AbortSignal.timeout(90_000),
    headers: { accept: "application/xml" },
  });
  if (!res.ok) throw new Error(`OFAC SDN fetch failed: HTTP ${res.status}`);
  const xml = await res.text();
  if (xml.length < MIN_PLAUSIBLE_BYTES) {
    throw new Error(`OFAC SDN fetch suspiciously small (${xml.length} bytes) — refusing to parse`);
  }

  const publishRaw = firstGroup(/<Publish_Date>([^<]+)<\/Publish_Date>/, xml)?.trim();
  if (!publishRaw) throw new Error("OFAC SDN: no <Publish_Date> — unexpected format");
  const recordCount = Number(firstGroup(/<Record_Count>([^<]+)<\/Record_Count>/, xml)?.trim() ?? "0");

  const addresses: ExtractedAddress[] = [];
  const entryRe = /<sdnEntry>([\s\S]*?)<\/sdnEntry>/g;
  let em: RegExpExecArray | null;
  while ((em = entryRe.exec(xml))) {
    const block = em[1];
    if (block.indexOf(XRP_ID_TYPE) === -1) continue;

    const uid = firstGroup(/<uid>([^<]+)<\/uid>/, block)?.trim() ?? "";
    const first = firstGroup(/<firstName>([^<]*)<\/firstName>/, block);
    const last = firstGroup(/<lastName>([^<]*)<\/lastName>/, block);
    const entryName =
      decodeXmlEntities([first, last].filter(Boolean).join(" ").trim()) || "(name not listed)";
    const programs = Array.from(block.matchAll(/<program>([^<]+)<\/program>/g))
      .map((m) => m[1].trim())
      .join(",");

    const idRe = /<id>([\s\S]*?)<\/id>/g;
    let im: RegExpExecArray | null;
    while ((im = idRe.exec(block))) {
      const idBlock = im[1];
      if (firstGroup(/<idType>([^<]+)<\/idType>/, idBlock)?.trim() !== XRP_ID_TYPE) continue;
      const idNumber = firstGroup(/<idNumber>([^<]+)<\/idNumber>/, idBlock)?.trim();
      if (!idNumber) continue;
      addresses.push({
        address: idNumber,
        entryId: uid,
        entryName,
        programs,
        addressField: XRP_ID_TYPE,
        idUid: firstGroup(/<uid>([^<]+)<\/uid>/, idBlock)?.trim() ?? "",
      });
    }
  }

  return { publishRaw, vintage: isoFromOfacDate(publishRaw), recordCount, addresses, xmlBytes: xml.length };
}

export interface CanonicalSnapshot {
  listName: string;
  vintage: string;
  publishRaw: string;
  recordCount: number;
  addressCount: number;
  sourceUrl: string;
  addresses: ExtractedAddress[]; // sorted by (address, idUid)
}

export function canonicaliseSnapshot(p: ParsedSdn): { canonical: CanonicalSnapshot; sha256: string } {
  const addresses = [...p.addresses].sort((a, b) =>
    a.address < b.address ? -1 : a.address > b.address ? 1 : a.idUid < b.idUid ? -1 : a.idUid > b.idUid ? 1 : 0
  );
  const canonical: CanonicalSnapshot = {
    listName: OFAC_SDN_LIST_NAME,
    vintage: p.vintage,
    publishRaw: p.publishRaw,
    recordCount: p.recordCount,
    addressCount: addresses.length,
    sourceUrl: SDN_XML_URL,
    addresses,
  };
  const sha256 = createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
  return { canonical, sha256 };
}

export interface RefreshResult {
  action: "written" | "unchanged" | "blocked-integrity" | "blocked-error";
  listName: string;
  vintage?: string;
  sha256?: string;
  addressCount?: number;
  snapshotId?: string;
  detail: string;
}

export async function refreshSdnSnapshot(prisma: PrismaClient): Promise<RefreshResult> {
  const prev = await prisma.sanctionListSnapshot.findFirst({
    where: { listName: OFAC_SDN_LIST_NAME },
    orderBy: { fetchedAt: "desc" },
  });

  // Gate 0 (cheap): if the header Publish_Date matches what we last stored, skip
  // the full download entirely. A hash re-check still runs on the days it differs.
  if (prev) {
    const peeked = await peekPublishDate();
    if (peeked && peeked === prev.publishRaw) {
      return {
        action: "unchanged",
        listName: OFAC_SDN_LIST_NAME,
        vintage: prev.vintage,
        sha256: prev.sha256,
        addressCount: prev.addressCount,
        snapshotId: prev.id,
        detail: `Publish_Date unchanged (${prev.publishRaw}) — full download skipped`,
      };
    }
  }

  let parsed: ParsedSdn;
  try {
    parsed = await fetchAndParseSdn();
  } catch (err) {
    await notifyError("ofac/refreshSdnSnapshot", err, { phase: "fetch/parse" });
    return {
      action: "blocked-error",
      listName: OFAC_SDN_LIST_NAME,
      detail: err instanceof Error ? err.message : "fetch failed",
    };
  }

  const { canonical, sha256 } = canonicaliseSnapshot(parsed);

  // Gate 1: integrity — never write an empty list over a non-empty one.
  if (canonical.addressCount === 0 && (prev?.addressCount ?? 0) > 0) {
    const msg =
      `OFAC SDN parse yielded 0 XRP addresses but the last snapshot (${prev!.vintage}) had ` +
      `${prev!.addressCount}. Refusing to write — this looks like a truncated or malformed fetch. ` +
      `Screening continues against the previous snapshot.`;
    await notifyError("ofac/refreshSdnSnapshot", new Error(msg), {
      phase: "integrity-gate",
      fetchedVintage: canonical.vintage,
      xmlBytes: parsed.xmlBytes,
    });
    return {
      action: "blocked-integrity",
      listName: OFAC_SDN_LIST_NAME,
      vintage: canonical.vintage,
      addressCount: 0,
      detail: msg,
    };
  }

  // Gate 2: nothing changed (hash match, or this exact snapshot already stored).
  const dup = await prisma.sanctionListSnapshot.findFirst({ where: { listName: OFAC_SDN_LIST_NAME, sha256 } });
  if (dup) {
    return {
      action: "unchanged",
      listName: OFAC_SDN_LIST_NAME,
      vintage: dup.vintage,
      sha256,
      addressCount: dup.addressCount,
      snapshotId: dup.id,
      detail: "content hash unchanged since a previous snapshot",
    };
  }

  const snap = await prisma.sanctionListSnapshot.create({
    data: {
      listName: OFAC_SDN_LIST_NAME,
      vintage: canonical.vintage,
      publishRaw: canonical.publishRaw,
      recordCount: canonical.recordCount,
      addressCount: canonical.addressCount,
      sha256,
      sourceUrl: canonical.sourceUrl,
      canonicalArchive: canonical as unknown as object,
      addresses: {
        create: canonical.addresses.map((a) => ({
          listName: OFAC_SDN_LIST_NAME,
          address: a.address,
          entryId: a.entryId,
          entryName: a.entryName,
          programs: a.programs,
          addressField: a.addressField,
          idUid: a.idUid,
        })),
      },
    },
  });

  return {
    action: "written",
    listName: OFAC_SDN_LIST_NAME,
    vintage: canonical.vintage,
    sha256,
    addressCount: canonical.addressCount,
    snapshotId: snap.id,
    detail: `new snapshot ${canonical.vintage} — ${canonical.addressCount} XRP address(es)`,
  };
}

/** The snapshot a screen runs against: the newest written OFAC-SDN snapshot. */
export function currentSdnSnapshot(prisma: PrismaClient) {
  return prisma.sanctionListSnapshot.findFirst({
    where: { listName: OFAC_SDN_LIST_NAME },
    orderBy: { fetchedAt: "desc" },
  });
}

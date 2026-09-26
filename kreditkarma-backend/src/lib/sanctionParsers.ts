// src/lib/sanctionParsers.ts
// Pure parsers (no network, no database) that turn a published sanctions list into the addresses it names.
// One parser per list. Each returns a ParsedList that sanctionLists.ts canonicalises, hashes and stores.
//
// WHAT EACH LIST ACTUALLY CONTAINS (read from the live files, 2026-09-25 — see docs/SCREENING-RESEARCH.md):
//   OFAC-SDN — STRUCTURED: <id> elements typed "Digital Currency Address - <CCY>", ~20 currencies.
//   UK-SL    — the FCDO UK Sanctions List (the OFSI Consolidated List CLOSED on 2026-01-28 and is not used).
//              Addresses appear ONLY as free text inside OtherInformation / UKStatementofReasons.
//   EU-FSF   — the EU consolidated financial-sanctions file. Addresses appear ONLY as free text inside <remark> elements
//              (one address in the file is even split by a space).
//   UN       — the UN consolidated list has NO addresses at all (name/entity based) and is deliberately NOT ingested:
//              we do not claim address screening against a list that names none.
// The EU/UK free-text extraction is a best-effort READ of unstructured text. It is checksum-verified (a token that is not a
// valid address is never accepted) and anything that LOOKS like an address but fails its checksum is reported in
// `unparsed` so a designation whose address we could not read is visible, not silently missed.

import { extractAddresses, recogniseAddress, type Chain } from "./chainAddress";

export type ListName = "OFAC-SDN" | "EU-FSF" | "UK-SL";
export const LIST_NAMES: readonly ListName[] = ["OFAC-SDN", "EU-FSF", "UK-SL"];

export interface ListEntry {
  /** As written in the source (after re-joining a split fragment). */
  address: string;
  /** The one comparison string: EVM / bech32 lower-cased, everything else verbatim. */
  normalized: string;
  /** A supported chain, or "other" for a currency we store but cannot screen a query against (LTC, XMR, DASH, ZEC, SOL, …). */
  chain: Chain | "other";
  /** OFAC: the currency in the idType (XBT, ETH, USDT…). EU/UK: the label written next to it in the text, if any. */
  currency: string | null;
  entryId: string;
  entryName: string;
  programs: string;
  /** Where in the source the address sits: OFAC idType, or the XML element that held the free text. */
  addressField: string;
  idUid: string;
}

export interface UnparsedCandidate {
  entryId: string;
  entryName: string;
  field: string;
  snippet: string;
}

export interface ParsedList {
  listName: ListName;
  sourceUrl: string;
  publishRaw: string;
  vintage: string; // ISO YYYY-MM-DD
  recordCount: number;
  entries: ListEntry[];
  unparsed: UnparsedCandidate[];
  xmlBytes: number;
}

/** The comparison key for an address string. Query addresses go through the same function. */
export function normalizeForMatch(address: string): string {
  const a = address.trim();
  if (/^0x[0-9a-fA-F]{40}$/i.test(a)) return a.toLowerCase();
  if (/^bc1/i.test(a)) return a.toLowerCase();
  return a;
}

export function decodeXmlEntities(s: string): string {
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

/** "mm/dd/yyyy" (OFAC) -> ISO. Returns the input unchanged if it does not match. */
export function isoFromMdY(mdY: string): string {
  const m = mdY.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : mdY.trim();
}
/** "dd/mm/yyyy" (UK) -> ISO. Returns the input unchanged if it does not match. */
export function isoFromDMY(dmy: string): string {
  const m = dmy.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : dmy.trim();
}

function entryFromRecognised(rec: { chain: Chain; address: string; normalized: string }, base: Omit<ListEntry, "address" | "normalized" | "chain">): ListEntry {
  return { ...base, address: rec.address, normalized: rec.normalized, chain: rec.chain };
}

// Text that looks like it is trying to be an address (long base58/hex/bech32-ish run) — used ONLY to flag a designation whose
// address we could not verify. A checksum-valid address never reaches this; a mistyped or unsupported one does.
const ADDRESS_LIKE = /(0x[0-9a-fA-F]{20,}|\bbc1[a-z0-9]{20,}|\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b|\bT[1-9A-HJ-NP-Za-km-z]{25,33}\b)/;
const CRYPTO_CONTEXT = /wallet|digital currency|blockchain|crypto/i;

function flagUnparsed(text: string, found: number, into: UnparsedCandidate[], entryId: string, entryName: string, field: string): void {
  if (found === 0 && CRYPTO_CONTEXT.test(text) && ADDRESS_LIKE.test(text)) {
    into.push({ entryId, entryName, field, snippet: text.replace(/\s+/g, " ").slice(0, 240) });
  }
}

// ── OFAC SDN (structured) ─────────────────────────────────────────────────────
export const OFAC_SDN_SOURCE = "https://sanctionslistservice.ofac.treas.gov/api/download/sdn.xml";
const DCA_PREFIX = "Digital Currency Address - ";

export function parseOfacSdn(xml: string): ParsedList {
  const publishRaw = firstGroup(/<Publish_Date>([^<]+)<\/Publish_Date>/, xml)?.trim();
  if (!publishRaw) throw new Error("OFAC SDN: no <Publish_Date> — unexpected format");
  const recordCount = Number(firstGroup(/<Record_Count>([^<]+)<\/Record_Count>/, xml)?.trim() ?? "0");
  const entries: ListEntry[] = [];
  const entryRe = /<sdnEntry>([\s\S]*?)<\/sdnEntry>/g;
  let em: RegExpExecArray | null;
  while ((em = entryRe.exec(xml))) {
    const block = em[1];
    if (block.indexOf(DCA_PREFIX) === -1) continue;
    const uid = firstGroup(/<uid>([^<]+)<\/uid>/, block)?.trim() ?? "";
    const first = firstGroup(/<firstName>([^<]*)<\/firstName>/, block);
    const last = firstGroup(/<lastName>([^<]*)<\/lastName>/, block);
    const entryName = decodeXmlEntities([first, last].filter(Boolean).join(" ").trim()) || "(name not listed)";
    const programs = Array.from(block.matchAll(/<program>([^<]+)<\/program>/g)).map((m) => m[1].trim()).join(",");
    const idRe = /<id>([\s\S]*?)<\/id>/g;
    let im: RegExpExecArray | null;
    while ((im = idRe.exec(block))) {
      const idBlock = im[1];
      const idType = firstGroup(/<idType>([^<]+)<\/idType>/, idBlock)?.trim() ?? "";
      if (!idType.startsWith(DCA_PREFIX)) continue;
      const idNumber = firstGroup(/<idNumber>([^<]+)<\/idNumber>/, idBlock)?.trim();
      if (!idNumber) continue;
      const currency = idType.slice(DCA_PREFIX.length).trim() || null;
      const rec = recogniseAddress(idNumber);
      const base = { currency, entryId: uid, entryName, programs, addressField: idType, idUid: firstGroup(/<uid>([^<]+)<\/uid>/, idBlock)?.trim() ?? "" };
      if (rec) entries.push(entryFromRecognised(rec, base));
      else {
        // Not a family we can validate a query against. Store it (verbatim) so the archive is complete; XRP keeps the v1 meaning.
        entries.push({ ...base, address: idNumber, normalized: normalizeForMatch(idNumber), chain: currency === "XRP" ? "xrpl" : "other" });
      }
    }
  }
  return { listName: "OFAC-SDN", sourceUrl: OFAC_SDN_SOURCE, publishRaw, vintage: isoFromMdY(publishRaw), recordCount, entries, unparsed: [], xmlBytes: xml.length };
}

// ── EU consolidated financial sanctions file (free text in <remark>) ──────────
export const EU_FSF_SOURCE = "https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw";

export function parseEuFsf(xml: string): ParsedList {
  const publishRaw = firstGroup(/generationDate="([^"]+)"/, xml)?.trim();
  if (!publishRaw) throw new Error("EU FSF: no generationDate — unexpected format");
  const entries: ListEntry[] = [];
  const unparsed: UnparsedCandidate[] = [];
  let recordCount = 0;
  const entRe = /<sanctionEntity\b([^>]*)>([\s\S]*?)<\/sanctionEntity>/g;
  let m: RegExpExecArray | null;
  while ((m = entRe.exec(xml))) {
    recordCount++;
    const attrs = m[1];
    const block = m[2];
    const entryId = firstGroup(/euReferenceNumber="([^"]*)"/, attrs) || firstGroup(/logicalId="([^"]*)"/, attrs) || "";
    const entryName = decodeXmlEntities(firstGroup(/<nameAlias\b[^>]*\bwholeName="([^"]*)"/, block) ?? "") || "(name not listed)";
    const programs = firstGroup(/<regulation\b[^>]*\bprogramme="([^"]*)"/, block) ?? "";
    const remarkRe = /<remark>([\s\S]*?)<\/remark>/g;
    let rm: RegExpExecArray | null;
    while ((rm = remarkRe.exec(block))) {
      const text = decodeXmlEntities(rm[1]);
      const found = extractAddresses(text);
      for (const f of found) {
        entries.push({
          address: f.address,
          normalized: f.normalized,
          chain: f.chain,
          currency: f.labelInSource,
          entryId,
          entryName,
          programs,
          addressField: "remark",
          idUid: "",
        });
      }
      flagUnparsed(text, found.length, unparsed, entryId, entryName, "remark");
    }
  }
  return { listName: "EU-FSF", sourceUrl: EU_FSF_SOURCE, publishRaw, vintage: publishRaw.slice(0, 10), recordCount, entries: dedupe(entries), unparsed, xmlBytes: xml.length };
}

// ── UK Sanctions List (FCDO) — free text in OtherInformation / UKStatementofReasons ──
export const UK_SL_SOURCE = "https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml";

export function parseUkSl(xml: string): ParsedList {
  const publishRaw = firstGroup(/<DateGenerated>([^<]+)<\/DateGenerated>/, xml)?.trim();
  if (!publishRaw) throw new Error("UK Sanctions List: no <DateGenerated> — unexpected format");
  const entries: ListEntry[] = [];
  const unparsed: UnparsedCandidate[] = [];
  let recordCount = 0;
  const desRe = /<Designation>([\s\S]*?)<\/Designation>/g;
  let m: RegExpExecArray | null;
  while ((m = desRe.exec(xml))) {
    recordCount++;
    const block = m[1];
    const entryId = firstGroup(/<UniqueID>([^<]*)<\/UniqueID>/, block)?.trim() || firstGroup(/<OFSIGroupID>([^<]*)<\/OFSIGroupID>/, block)?.trim() || "";
    const primary = firstGroup(/<Name>([\s\S]*?<NameType>Primary Name<\/NameType>[\s\S]*?)<\/Name>/, block) ?? "";
    const nameParts = ["Name1", "Name2", "Name3", "Name4", "Name5", "Name6"].map((t) => firstGroup(new RegExp(`<${t}>([^<]*)</${t}>`), primary)?.trim()).filter(Boolean);
    const entryName = decodeXmlEntities(nameParts.join(" ")) || "(name not listed)";
    const programs = decodeXmlEntities(firstGroup(/<RegimeName>([^<]*)<\/RegimeName>/, block) ?? "");
    const elRe = /<([A-Za-z]+)>([^<]{25,})<\/\1>/g;
    let em: RegExpExecArray | null;
    while ((em = elRe.exec(block))) {
      const field = em[1];
      const text = decodeXmlEntities(em[2]);
      const found = extractAddresses(text);
      for (const f of found) {
        entries.push({ address: f.address, normalized: f.normalized, chain: f.chain, currency: f.labelInSource, entryId, entryName, programs, addressField: field, idUid: "" });
      }
      flagUnparsed(text, found.length, unparsed, entryId, entryName, field);
    }
  }
  return { listName: "UK-SL", sourceUrl: UK_SL_SOURCE, publishRaw, vintage: isoFromDMY(publishRaw), recordCount, entries: dedupe(entries), unparsed, xmlBytes: xml.length };
}

/** One row per (entry, chain, normalized address): the same address repeated across aliases/fields of one designation counts once. */
function dedupe(entries: ListEntry[]): ListEntry[] {
  const seen = new Set<string>();
  const out: ListEntry[] = [];
  for (const e of entries) {
    const k = `${e.entryId}|${e.chain}|${e.normalized}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

export function chainCounts(entries: ListEntry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entries) out[e.chain] = (out[e.chain] || 0) + 1;
  return out;
}

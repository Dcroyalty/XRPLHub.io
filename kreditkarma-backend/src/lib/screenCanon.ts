// src/lib/screenCanon.ts
// FROZEN canonicalisation for OFAC SDN screening receipts — canonVersion
// "ofac-screen-v1". (Since 2026-09-25 new receipts are "sanctions-screen-v2", defined at the bottom of this file; this v1 section is
// unchanged and every v1 receipt stays verifiable with it forever.) A receipt attests to PROCESS: XRPL address X was compared
// against OFAC-SDN snapshot V at time T, result R. It never asserts that any
// address or person is sanctioned, clean, safe, or risky.
//
// The leaf record's KEY ORDER is load-bearing (JS preserves string-key
// insertion order; JSON.stringify emits no whitespace). Leaf hash, Merkle tree
// and root are byte-identical to the MPT registry anchor scheme (RFC 6962,
// 0x00 leaf prefix / 0x01 node prefix, odd node promoted).
//
// GET /api/attest/anchor echoes SCREEN_CANON_SPEC so a third party can rebuild
// any leaf from the published receipt fields and check it against the
// on-ledger root.

import { createHash } from "crypto";

export const SCREEN_CANON_VERSION_V1 = "ofac-screen-v1";

// ── ENGINE VERSION — a promise, not a label ──────────────────────────────────
// A receipt that says "sanction-screen-v1" was produced by EXACTLY the
// algorithm described in SCREEN_ENGINE_RULES. Bump this (v2, v3, …) IN THE SAME
// COMMIT as the change if ANY of the following change:
//   • how the query address is normalised before comparison
//   • what counts as a match (aliases, names, fuzzy, the OFAC 50% Rule, graph
//     adjacency, …)
//   • which idType(s) are extracted as XRP addresses from the SDN file
//   • which source list(s) are compared against
//   • which snapshot is selected for a screen
// NOT a version bump: ingesting a newer SDN snapshot (that is `vintage`, pinned
// per receipt); output-preserving refactors; response-envelope fields that are
// not part of the canonical leaf.
export const SCREEN_ENGINE_VERSION_V1 = "sanction-screen-v1";

export const SCREEN_ENGINE_RULES_V1 = {
  version: SCREEN_ENGINE_VERSION_V1,
  normalisation:
    "Strip leading and trailing ASCII whitespace from the query address. No case folding (XRPL " +
    "base58check is case-sensitive), no Unicode normalisation, no other transformation.",
  match:
    "Exact byte-string equality between the normalised query address and the idNumber of an <id> whose " +
    "idType is exactly 'Digital Currency Address - XRP', within the selected snapshot.",
  extraction:
    "From the OFAC SDN.xml, take every <id> element whose idType is exactly 'Digital Currency Address - XRP'; " +
    "idNumber is used verbatim (trimmed).",
  sources: ["OFAC-SDN"],
  snapshotSelection: "The most recent successfully-written OFAC-SDN snapshot at screen time.",
  excludes:
    "No alias or name matching. No fuzzy matching. No OFAC 50 Percent Rule traversal. No OFAC Consolidated " +
    "(non-SDN) list. No EU / UK / UN or other lists. No transaction-graph or counterparty (1-hop) analysis.",
} as const;

export const SCREEN_CANON_SPEC_V1 = {
  version: SCREEN_CANON_VERSION_V1,
  engine: SCREEN_ENGINE_RULES_V1,
  record: {
    description:
      "Build a JSON object with EXACTLY these keys in this order, then JSON.stringify with no extra " +
      "whitespace (UTF-8 bytes).",
    keys: [
      "queryId", // UUIDv4
      "subjectAddress", // the XRPL address screened, verbatim as supplied (after whitespace trim)
      "requestedBy", // "key:<keyPrefix>" | "x402:<paymentId>" | "mcp" | "public"
      "lists", // [{ "name", "vintage", "sha256" }], sorted by name ascending
      "method", // "exact-match"
      "result", // { "listed": false } | { "listed": true, "matches": [ { "list","entryId","entryName","addressField" } ] }; matches sorted by [list, entryId]
      "engineVersion", // "sanction-screen-v1"
      "ledgerIndex", // validated ledger index pinned at screen time; 0 if unknown
      "screenedAt", // RFC 3339 UTC, millisecond precision, 'Z'
    ],
  },
  leaves:
    "Order the receipts in an anchor batch by queryId ascending (byte order). " +
    "Leaf hash = SHA-256( 0x00 || utf8(recordJson) ).",
  merkle:
    "RFC 6962 style. Internal node = SHA-256( 0x01 || left || right ). A level with an odd number of nodes " +
    "promotes its last node unchanged. A single-leaf tree's root is that leaf hash. The empty tree's root is " +
    "SHA-256 of the empty string.",
  root: "Lowercase 64-char hex.",
  onLedger: {
    account: "r9dQS1oGms3B7SdY6nyU24Dy7dWyWXuJXb",
    accountNote:
      "Trust roots ONLY from this address — the dedicated XRPLHub anchor wallet, deliberately NOT the " +
      "credential issuer. A compromised anchor key can publish false memos (recoverable); it cannot mint credentials.",
    transactionType: "AccountSet",
    memoType: `XRPLHub-Screening-Attestation/${SCREEN_CANON_VERSION_V1}`,
    memoFormat: "application/json",
    memoDataIs:
      "hex(UTF-8 JSON) — { v, root, leaves, rangeStart, rangeEnd, ts }. Decode MemoData from hex; its `root` " +
      "field is the Merkle root.",
  },
} as const;

const SHA0 = Buffer.from([0x00]);
const sha = (b: Buffer) => createHash("sha256").update(b).digest();

export interface ScreenMatch {
  list: string;
  entryId: string;
  entryName: string;
  addressField: string;
}
export type ScreenResult = { listed: false } | { listed: true; matches: ScreenMatch[] };

export interface ScreenListRef {
  name: string;
  vintage: string;
  sha256: string;
}

export interface ScreenLeaf {
  queryId: string;
  subjectAddress: string;
  requestedBy: string;
  lists: ScreenListRef[];
  method: "exact-match";
  result: ScreenResult;
  engineVersion: string;
  ledgerIndex: number;
  screenedAt: string;
}

/** Deterministic serialisation — explicit key order, sorted sub-arrays. */
export function canonScreenJson(leaf: ScreenLeaf): string {
  const lists = [...leaf.lists]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((l) => ({ name: l.name, vintage: l.vintage, sha256: l.sha256 }));

  const result: ScreenResult = leaf.result.listed
    ? {
        listed: true,
        matches: [...leaf.result.matches]
          .sort((a, b) =>
            a.list !== b.list
              ? a.list < b.list
                ? -1
                : 1
              : a.entryId < b.entryId
                ? -1
                : a.entryId > b.entryId
                  ? 1
                  : 0
          )
          .map((m) => ({ list: m.list, entryId: m.entryId, entryName: m.entryName, addressField: m.addressField })),
      }
    : { listed: false };

  return JSON.stringify({
    queryId: leaf.queryId,
    subjectAddress: leaf.subjectAddress,
    requestedBy: leaf.requestedBy,
    lists,
    method: leaf.method,
    result,
    engineVersion: leaf.engineVersion,
    ledgerIndex: leaf.ledgerIndex,
    screenedAt: leaf.screenedAt,
  });
}

export function screenLeafHash(leaf: ScreenLeaf): string {
  return sha(Buffer.concat([SHA0, Buffer.from(canonScreenJson(leaf), "utf8")])).toString("hex");
}

// RFC 6962 Merkle helpers live in ./merkle (shared with the lending-exposure
// attestation). Re-exported here so existing importers of screenCanon are unchanged.
export {
  merkleRootFromLeafHashes,
  merkleInclusionProof,
  verifyInclusion,
  type ProofStep,
} from "./merkle";

/** The one factual sentence a receipt renders — never a conclusion. */
export function renderStatement(leaf: ScreenLeaf): string {
  const l = [...leaf.lists].sort((a, b) => (a.name < b.name ? -1 : 1))[0];
  const head =
    `As of ${leaf.screenedAt}, XRPL address ${leaf.subjectAddress} was compared against the ${l.name} list, ` +
    `published version ${l.vintage} (file SHA-256 ${l.sha256}), and `;
  if (leaf.result.listed) {
    return (
      head +
      "appears on it as " +
      leaf.result.matches
        .map((m) => `entry ${m.entryId} (${m.entryName}), field '${m.addressField}'`)
        .join("; ") +
      "."
    );
  }
  return head + "did not appear on it.";
}

// ════════════════════════════════════════════════════════════════════════════════
// canonVersion "sanctions-screen-v2" — multi-list, multi-chain (introduced 2026-09-25)
// ════════════════════════════════════════════════════════════════════════════════
// v1 (above) is FROZEN and stays verifiable forever: every receipt written before v2 keeps canonVersion "ofac-screen-v1" and
// is rebuilt with the v1 functions. v2 receipts are rebuilt with the v2 functions below. A receipt NEVER changes version.
//
// What v2 adds to the leaf: the subject's chain, the caller's own reference, the retention commitment in force, and — inside
// each list reference — how many addresses that list names ON THE SUBJECT'S CHAIN. That last field exists so a receipt is
// honest about what was actually compared: an XRP Ledger address checked against the EU list was checked against ZERO
// XRP Ledger addresses (the EU list names none), and the receipt says so instead of implying a clean bill of health.

import type { Chain } from "./chainAddress";

export const SCREEN_CANON_VERSION_V2 = "sanctions-screen-v2";
export const SCREEN_ENGINE_VERSION_V2 = "sanction-screen-v2";
/** The retention commitment stamped into every v2 receipt. Full text: SCREEN_RETENTION_TEXT and /legal/screening. */
export const SCREEN_RETENTION_CODE = "retain-10y-no-prune/v1";
export const SCREEN_RETENTION_TEXT =
  "XRPLHub retains every screening receipt, its canonical leaf, the inputs needed to rebuild its Merkle inclusion proof, its on-ledger " +
  "anchor record, and the archive of every list snapshot a receipt refers to, for at least 10 years from the date of the screening. " +
  "There is no process in XRPLHub that prunes, edits or deletes a receipt or a list snapshot. This is XRPLHub's storage commitment only: " +
  "it does not discharge your own record-keeping duty (for example five years under Article 68(9) of Regulation (EU) 2023/1114 and the " +
  "EU AML record-keeping rules, extendable), so export your receipts (GET /api/attest/export) and keep your own copy.";

/** The current version: everything new is written as v2. */
export const SCREEN_CANON_VERSION = SCREEN_CANON_VERSION_V2;
export const SCREEN_ENGINE_VERSION = SCREEN_ENGINE_VERSION_V2;

export const SCREEN_ENGINE_RULES_V2 = {
  version: SCREEN_ENGINE_VERSION_V2,
  normalisation:
    "Strip leading and trailing ASCII whitespace. Recognise the address by CHECKSUM as one of: XRP Ledger classic r-address (base58check, XRPL alphabet); " +
    "EVM 0x + 40 hex (EIP-55 verified when mixed-case); Bitcoin (base58check P2PKH/P2SH, or bech32/bech32m bc1…); Tron (base58check, version 0x41). " +
    "EVM addresses and bech32 addresses are compared lower-cased; every other address is compared verbatim (case-sensitive). An address that is not " +
    "on one of these chains, or whose checksum fails, is REFUSED (no receipt): it is never reported as 'not listed'.",
  match:
    "Exact string equality between the normalised query address and the normalised address of a list entry on the SAME chain, within the selected snapshot " +
    "of each list named in the receipt.",
  extraction: {
    "OFAC-SDN": "Every <id> whose idType starts with 'Digital Currency Address - ' (about 20 currencies); the address is classified by checksum, or stored as chain 'other' if its chain is not supported.",
    "EU-FSF": "Free text: every checksum-valid supported-chain address found in the <remark> elements of the EU consolidated list. A fragment split by whitespace is re-joined only if the joined string verifies.",
    "UK-SL": "Free text: every checksum-valid supported-chain address found in the text elements (OtherInformation, UKStatementofReasons, …) of the FCDO UK Sanctions List.",
  },
  sources: ["OFAC-SDN", "EU-FSF", "UK-SL"],
  snapshotSelection:
    "For each list named in the receipt, the most recent successfully-written snapshot with archiveVersion >= 2 at screen time (for OFAC-SDN before its first v2 snapshot: " +
    "the newest v1 snapshot, XRP Ledger addresses only). A list whose snapshot does not cover the subject's chain is reported as unavailable (HTTP 503) — never skipped silently.",
  freshness:
    "Lists are re-fetched once a day (about 06:00 UTC). A designation published between two refreshes is not reflected until the next one; each receipt states the vintage it used.",
  excludes:
    "No name, alias or fuzzy matching (these lists are name/entity-based: address matching covers only the addresses they name). No OFAC 50 Percent Rule. No UN list " +
    "(it names no crypto addresses). No other national lists. No transaction-graph or counterparty analysis. Addresses on chains other than the four supported are refused.",
} as const;

export const SCREEN_CANON_SPEC_V2 = {
  version: SCREEN_CANON_VERSION_V2,
  engine: SCREEN_ENGINE_RULES_V2,
  record: {
    description:
      "Build a JSON object with EXACTLY these keys in this order, then JSON.stringify with no extra whitespace (UTF-8 bytes).",
    keys: [
      "queryId", // UUIDv4
      "subjectAddress", // the address screened, verbatim as supplied (after whitespace trim)
      "subjectChain", // "xrpl" | "evm" | "btc" | "tron"
      "reference", // the caller's own opaque reference (e.g. a Travel Rule transfer id) or null. Never personal data.
      "requestedBy", // "key:<keyPrefix>" | "x402:<paymentId>" | "mcp" | "monitor:<subscriptionId>"
      "lists", // [{ "name", "vintage", "sha256", "chainAddressCount" }] sorted by name ascending; chainAddressCount = addresses the list names on subjectChain
      "method", // "exact-match"
      "result", // { "listed": false } | { "listed": true, "matches": [ { "list","entryId","entryName","addressField" } ] }; matches sorted by [list, entryId, addressField]
      "engineVersion", // "sanction-screen-v2"
      "retention", // "retain-10y-no-prune/v1"
      "ledgerIndex", // validated XRPL ledger index pinned at screen time; 0 if unknown
      "screenedAt", // RFC 3339 UTC, millisecond precision, 'Z'
    ],
  },
  leaves:
    "Order the receipts in an anchor batch by queryId ascending (byte order). Leaf hash = SHA-256( 0x00 || utf8(recordJson) ). " +
    "An anchor batch may contain receipts of more than one canonVersion; each leaf is hashed with the canonicalisation of ITS OWN canonVersion.",
  merkle:
    "RFC 6962 style. Internal node = SHA-256( 0x01 || left || right ). A level with an odd number of nodes promotes its last node unchanged. " +
    "A single-leaf tree's root is that leaf hash. The empty tree's root is SHA-256 of the empty string.",
  root: "Lowercase 64-char hex.",
  onLedger: {
    account: "r9dQS1oGms3B7SdY6nyU24Dy7dWyWXuJXb",
    accountNote:
      "Trust roots ONLY from this address — the dedicated XRPLHub anchor wallet, deliberately NOT the credential issuer. A compromised anchor key can publish false memos (recoverable); it cannot mint credentials.",
    transactionType: "AccountSet",
    memoType: `XRPLHub-Screening-Attestation/${SCREEN_CANON_VERSION_V2}`,
    memoFormat: "application/json",
    memoDataIs: "hex(UTF-8 JSON) — { v, root, leaves, rangeStart, rangeEnd, ts }. Decode MemoData from hex; its `root` field is the Merkle root.",
  },
  retention: { code: SCREEN_RETENTION_CODE, text: SCREEN_RETENTION_TEXT },
} as const;

/** Memo type of the on-ledger anchor for a given canonVersion (v1 anchors were written under the v1 memo type and stay that way). */
export function screenMemoTypeFor(canonVersion: string): string {
  return `XRPLHub-Screening-Attestation/${canonVersion}`;
}

export function screenCanonSpecFor(canonVersion: string) {
  return canonVersion === SCREEN_CANON_VERSION_V1 ? SCREEN_CANON_SPEC_V1 : SCREEN_CANON_SPEC_V2;
}

export interface ScreenListRefV2 {
  name: string;
  vintage: string;
  sha256: string;
  /** How many addresses this list snapshot names on the subject's chain (0 is meaningful: e.g. the EU list names no XRPL address). */
  chainAddressCount: number;
}

export interface ScreenLeafV2 {
  queryId: string;
  subjectAddress: string;
  subjectChain: Chain;
  reference: string | null;
  requestedBy: string;
  lists: ScreenListRefV2[];
  method: "exact-match";
  result: ScreenResult;
  engineVersion: string;
  retention: string;
  ledgerIndex: number;
  screenedAt: string;
}

const byStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function canonScreenJsonV2(leaf: ScreenLeafV2): string {
  const lists = [...leaf.lists]
    .sort((a, b) => byStr(a.name, b.name))
    .map((l) => ({ name: l.name, vintage: l.vintage, sha256: l.sha256, chainAddressCount: l.chainAddressCount }));
  const result: ScreenResult = leaf.result.listed
    ? {
        listed: true,
        matches: [...leaf.result.matches]
          .sort((a, b) => byStr(a.list, b.list) || byStr(a.entryId, b.entryId) || byStr(a.addressField, b.addressField))
          .map((m) => ({ list: m.list, entryId: m.entryId, entryName: m.entryName, addressField: m.addressField })),
      }
    : { listed: false };
  return JSON.stringify({
    queryId: leaf.queryId,
    subjectAddress: leaf.subjectAddress,
    subjectChain: leaf.subjectChain,
    reference: leaf.reference,
    requestedBy: leaf.requestedBy,
    lists,
    method: leaf.method,
    result,
    engineVersion: leaf.engineVersion,
    retention: leaf.retention,
    ledgerIndex: leaf.ledgerIndex,
    screenedAt: leaf.screenedAt,
  });
}

export function screenLeafHashV2(leaf: ScreenLeafV2): string {
  return sha(Buffer.concat([SHA0, Buffer.from(canonScreenJsonV2(leaf), "utf8")])).toString("hex");
}

const CHAIN_NAME: Record<string, string> = { xrpl: "XRP Ledger", evm: "EVM", btc: "Bitcoin", tron: "Tron" };

/** The one factual paragraph a v2 receipt renders — never a conclusion. */
export function renderStatementV2(leaf: ScreenLeafV2): string {
  const chain = CHAIN_NAME[leaf.subjectChain] ?? leaf.subjectChain;
  const lists = [...leaf.lists].sort((a, b) => byStr(a.name, b.name));
  const compared = lists
    .map((l) => `${l.name} published version ${l.vintage} (file SHA-256 ${l.sha256.slice(0, 8)}…${l.sha256.slice(-4)}; names ${l.chainAddressCount} ${chain} address${l.chainAddressCount === 1 ? "" : "es"})`)
    .join("; ");
  const head = `As of ${leaf.screenedAt}, ${chain} address ${leaf.subjectAddress} was compared against: ${compared}. `;
  if (leaf.result.listed) {
    const matchedLists = new Set(leaf.result.matches.map((m) => m.list));
    const others = lists.filter((l) => !matchedLists.has(l.name)).map((l) => l.name);
    return (
      head +
      "It appears on: " +
      leaf.result.matches.map((m) => `${m.list} entry ${m.entryId} (${m.entryName}), field '${m.addressField}'`).join("; ") +
      "." +
      (others.length ? ` It did not appear on: ${others.join(", ")}.` : "")
    );
  }
  return head + "It did not appear on any of these list versions.";
}

/** Rebuild the leaf hash for a stored receipt of ANY canonVersion. */
export function leafHashForCanon(canonVersion: string, leaf: ScreenLeaf | ScreenLeafV2): string {
  return canonVersion === SCREEN_CANON_VERSION_V1 ? screenLeafHash(leaf as ScreenLeaf) : screenLeafHashV2(leaf as ScreenLeafV2);
}

/** The published spec for NEW receipts (v2). The v1 spec is SCREEN_CANON_SPEC_V1 (see screenCanonSpecFor). */
export const SCREEN_CANON_SPEC = SCREEN_CANON_SPEC_V2;
export const SCREEN_ENGINE_RULES = SCREEN_ENGINE_RULES_V2;

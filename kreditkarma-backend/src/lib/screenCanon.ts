// src/lib/screenCanon.ts
// FROZEN canonicalisation for OFAC SDN screening receipts — canonVersion
// "ofac-screen-v1". A receipt attests to PROCESS: XRPL address X was compared
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

export const SCREEN_CANON_VERSION = "ofac-screen-v1";

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
export const SCREEN_ENGINE_VERSION = "sanction-screen-v1";

export const SCREEN_ENGINE_RULES = {
  version: SCREEN_ENGINE_VERSION,
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

export const SCREEN_CANON_SPEC = {
  version: SCREEN_CANON_VERSION,
  engine: SCREEN_ENGINE_RULES,
  record: {
    description:
      "Build a JSON object with EXACTLY these keys in this order, then JSON.stringify with no extra " +
      "whitespace (UTF-8 bytes).",
    keys: [
      "queryId", // UUIDv4
      "subjectAddress", // the XRPL address screened, verbatim as supplied (after whitespace trim)
      "requestedBy", // "key:<keyPrefix>" | "x402:<invoiceId>" | "public"
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
    memoType: `XRPLHub-Screening-Attestation/${SCREEN_CANON_VERSION}`,
    memoFormat: "application/json",
    memoDataIs:
      "hex(UTF-8 JSON) — { v, root, leaves, rangeStart, rangeEnd, ts }. Decode MemoData from hex; its `root` " +
      "field is the Merkle root.",
  },
} as const;

const SHA0 = Buffer.from([0x00]);
const SHA1 = Buffer.from([0x01]);
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

/** RFC 6962 Merkle root over an ordered list of 64-hex leaf-hash strings. */
export function merkleRootFromLeafHashes(leafHashesHex: string[]): string {
  if (leafHashesHex.length === 0) return createHash("sha256").update("").digest("hex");
  let level: Buffer[] = leafHashesHex.map((h) => Buffer.from(h, "hex") as Buffer);
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) next.push(sha(Buffer.concat([SHA1, level[i], level[i + 1]])));
      else next.push(level[i]); // odd node promoted unchanged
    }
    level = next;
  }
  return level[0].toString("hex");
}

export interface ProofStep {
  position: "left" | "right";
  hash: string;
}

/** Inclusion proof for leaf index `target` in the ordered leaf-hash list. */
export function merkleInclusionProof(leafHashesHex: string[], target: number): ProofStep[] {
  const proof: ProofStep[] = [];
  let idx = target;
  let level: Buffer[] = leafHashesHex.map((h) => Buffer.from(h, "hex") as Buffer);
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        next.push(sha(Buffer.concat([SHA1, level[i], level[i + 1]])));
        if (i === idx) proof.push({ position: "right", hash: level[i + 1].toString("hex") });
        else if (i + 1 === idx) proof.push({ position: "left", hash: level[i].toString("hex") });
      } else {
        next.push(level[i]); // promoted; no sibling to record
      }
    }
    idx = Math.floor(idx / 2);
    level = next;
  }
  return proof;
}

/** Fold a leaf hash + inclusion proof back to a root and compare. */
export function verifyInclusion(leafHashHex: string, proof: ProofStep[], rootHex: string): boolean {
  let h: Buffer = Buffer.from(leafHashHex, "hex") as Buffer;
  for (const step of proof) {
    const sib = Buffer.from(step.hash, "hex");
    h = step.position === "left" ? sha(Buffer.concat([SHA1, sib, h])) : sha(Buffer.concat([SHA1, h, sib]));
  }
  return h.toString("hex") === rootHex;
}

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

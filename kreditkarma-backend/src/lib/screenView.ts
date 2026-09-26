// src/lib/screenView.ts
// The one JSON shape every screening endpoint returns for a receipt, so the single, batch, OFAC-only, x402 and MCP surfaces
// cannot drift apart. Nothing here decides anything: it renders what the receipt says.

import type { ScreenOutcome } from "./screen";
import { SCREEN_DISCLAIMER_SHORT } from "./screen";
import { SCREEN_CANON_VERSION, SCREEN_RETENTION_CODE, SCREEN_RETENTION_TEXT } from "./screenCanon";
import { UNSUPPORTED_LISTS_NOTE } from "./sanctionLists";

export const VERIFY_BASE = "https://www.xrplhub.io/api/attest/verify?queryId=";

export const RETENTION_VIEW = {
  code: SCREEN_RETENTION_CODE,
  minimumYears: 10,
  pruning: "none — no process deletes or edits a receipt or a list snapshot",
  text: SCREEN_RETENTION_TEXT,
  terms: "https://www.xrplhub.io/legal/screening#retention",
} as const;

export function receiptView(out: ScreenOutcome, opts: { includeCanonical?: boolean } = {}) {
  return {
    attestation: {
      queryId: out.queryId,
      canonVersion: SCREEN_CANON_VERSION,
      engineVersion: out.leaf.engineVersion,
      leafHash: out.leafHash,
      anchor: { status: "pending", note: "Recorded now; included in the next daily Merkle anchor. Poll the verify URL." },
      verify: `${VERIFY_BASE}${out.queryId}`,
    },
    subject: out.leaf.subjectAddress,
    subjectChain: out.leaf.subjectChain,
    reference: out.leaf.reference,
    screenedAt: out.leaf.screenedAt,
    method: "exact-match" as const,
    ledgerIndex: out.leaf.ledgerIndex,
    lists: out.leaf.lists,
    result: out.leaf.result,
    statement: out.statement,
    ...(opts.includeCanonical === false ? {} : { canonicalLeaf: out.canonicalJson }),
    retention: SCREEN_RETENTION_CODE,
  };
}

export function fullReceiptResponse(out: ScreenOutcome) {
  return {
    ...receiptView(out),
    limitations: LIMITATIONS,
    unlistedByDesign: UNSUPPORTED_LISTS_NOTE,
    disclaimer: SCREEN_DISCLAIMER_SHORT,
  };
}

/** What this screening does and does not do — repeated in the API, the spec and the Terms so no reader can miss it. */
export const LIMITATIONS = [
  "Attests to process, not ground truth: 'no match' means the address did not appear on the named list versions; it is not a statement that the address is clean or unsanctioned.",
  "Exact address-string match only, per chain. No name, alias or fuzzy matching: the EU and UK lists are name/entity-based and name only a handful of crypto addresses in free text; address screening covers only the addresses they name.",
  "Lists are refreshed once a day (about 06:00 UTC); a designation published in between is not reflected until the next refresh. Each receipt states the version it used.",
  "Supported chains: XRP Ledger, EVM (Ethereum, BNB Smart Chain, …), Bitcoin, Tron. An address on another chain is refused, never reported as 'not listed'.",
  "The UN Security Council list is not screened: it names no crypto addresses.",
  "Not legal or compliance advice; not a compliance determination. Using a receipt does not satisfy or reduce your own screening, due-diligence or record-keeping obligations.",
] as const;

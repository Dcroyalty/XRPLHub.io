// src/lib/screen.ts
// One OFAC SDN screen: exact address-string match against the current snapshot.
// Produces a canonical receipt leaf, persists it, returns the receipt. The
// receipt attests to PROCESS ONLY — see src/lib/screenCanon.ts. It never states
// or implies that an address is sanctioned, clean, safe, or risky.

import { randomUUID } from "crypto";
import type { PrismaClient } from "@prisma/client";
import {
  SCREEN_CANON_VERSION,
  SCREEN_ENGINE_VERSION,
  canonScreenJson,
  screenLeafHash,
  renderStatement,
  type ScreenLeaf,
  type ScreenResult,
  type ScreenListRef,
} from "./screenCanon";
import { currentSdnSnapshot, OFAC_SDN_LIST_NAME } from "./ofac";
import { XRPL_NODES } from "./xrplscore";

export const SCREEN_DISCLAIMER_SHORT =
  "This receipt records one factual comparison: the address was checked against the OFAC SDN list at the " +
  'published version named above, at the stated time. A "no match" means the address did not appear on that ' +
  "list version — it is not a statement that the address is clean, safe, or unsanctioned. XRPLHub is not a " +
  "regulated entity, gives no legal or compliance advice, and makes no compliance decision. Using this receipt " +
  "does not satisfy or reduce your own screening obligations. You are responsible for your compliance program " +
  "and for verifying any result. Full terms: https://www.xrplhub.io/legal/screening";

export class NoSnapshotError extends Error {
  constructor() {
    super("No OFAC SDN snapshot has been ingested yet — screening is not ready.");
    this.name = "NoSnapshotError";
  }
}

export interface ScreenOutcome {
  queryId: string;
  leaf: ScreenLeaf;
  leafHash: string;
  canonicalJson: string;
  snapshotId: string;
  statement: string;
}

const TRIM_WS = /^\s+|\s+$/g;

export async function runOfacScreen(
  prisma: PrismaClient,
  rawAddress: string,
  requestedBy: string,
  ledgerIndex: number
): Promise<ScreenOutcome> {
  const snap = await currentSdnSnapshot(prisma);
  if (!snap) throw new NoSnapshotError();

  const subjectAddress = rawAddress.replace(TRIM_WS, "");

  const hits = await prisma.sanctionedAddress.findMany({
    where: { snapshotId: snap.id, listName: OFAC_SDN_LIST_NAME, address: subjectAddress },
  });

  const result: ScreenResult = hits.length
    ? {
        listed: true,
        matches: hits.map((h) => ({
          list: OFAC_SDN_LIST_NAME,
          entryId: h.entryId,
          entryName: h.entryName,
          addressField: h.addressField,
        })),
      }
    : { listed: false };

  const lists: ScreenListRef[] = [{ name: OFAC_SDN_LIST_NAME, vintage: snap.vintage, sha256: snap.sha256 }];
  const screenedAt = new Date().toISOString(); // ms precision, 'Z'
  const queryId = randomUUID();

  const leaf: ScreenLeaf = {
    queryId,
    subjectAddress,
    requestedBy,
    lists,
    method: "exact-match",
    result,
    engineVersion: SCREEN_ENGINE_VERSION,
    ledgerIndex,
    screenedAt,
  };

  const canonicalJson = canonScreenJson(leaf);
  const leafHash = screenLeafHash(leaf);

  await prisma.screeningReceipt.create({
    data: {
      queryId,
      subjectAddress,
      requestedBy,
      screenedAt: new Date(screenedAt),
      method: "exact-match",
      ledgerIndex,
      listsJson: lists as unknown as object,
      resultJson: result as unknown as object,
      engineVersion: SCREEN_ENGINE_VERSION,
      canonVersion: SCREEN_CANON_VERSION,
      leafHash,
      snapshotId: snap.id,
    },
  });

  return { queryId, leaf, leafHash, canonicalJson, snapshotId: snap.id, statement: renderStatement(leaf) };
}

/** Pin the current validated XRPL ledger index as a time anchor for a screen.
 *  Independent of whether the subject is an activated account. 0 on failure —
 *  the receipt records that honestly. */
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
      const j = (await res.json()) as {
        result?: { ledger_index?: number; ledger?: { ledger_index?: number | string } };
      };
      const li = Number(j.result?.ledger_index ?? j.result?.ledger?.ledger_index ?? 0);
      if (Number.isFinite(li) && li > 0) return li;
    } catch {
      /* try next node */
    }
  }
  return 0;
}

/** Screen + pin the ledger in one call — the shape every caller (API-key route,
 *  x402 route, MCP tool) wants. */
export async function screenOfac(
  prisma: PrismaClient,
  rawAddress: string,
  requestedBy: string
): Promise<ScreenOutcome> {
  const ledgerIndex = await pinValidatedLedger();
  return runOfacScreen(prisma, rawAddress, requestedBy, ledgerIndex);
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

export const SCREEN_OFAC_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    attestation: {
      type: "object",
      properties: {
        queryId: { type: "string", description: "UUID. GET /api/attest/verify?queryId= for the Merkle inclusion proof once anchored." },
        canonVersion: { type: "string", enum: ["ofac-screen-v1"] },
        engineVersion: { type: "string", enum: ["sanction-screen-v1"], description: "Immutable per receipt — the exact match algorithm." },
        leafHash: { type: "string", description: "64-hex SHA-256(0x00 || canonical leaf)." },
        verify: { type: "string" },
      },
    },
    subject: { type: "string" },
    screenedAt: { type: "string", format: "date-time" },
    method: { type: "string", enum: ["exact-match"] },
    ledgerIndex: { type: "integer", description: "Validated XRPL ledger pinned as a time anchor; 0 if unavailable." },
    lists: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", enum: ["OFAC-SDN"] },
          vintage: { type: "string", description: "OFAC Publish Date of the snapshot screened against." },
          sha256: { type: "string", description: "Hash of the exact list file — makes the snapshot reproducible." },
        },
      },
    },
    result: {
      type: "object",
      properties: {
        listed: {
          type: "boolean",
          description:
            "true = the address string is on that SDN snapshot. false = it did not appear. false is NOT a statement that the address is clean, safe, or unsanctioned.",
        },
        matches: {
          type: "array",
          items: {
            type: "object",
            properties: {
              list: { type: "string" },
              entryId: { type: "string", description: "OFAC SDN entry UID." },
              entryName: { type: "string", description: "The SDN entry's own listed name (OFAC's published fact)." },
              addressField: { type: "string", description: "e.g. 'Digital Currency Address - XRP'." },
            },
          },
        },
      },
      required: ["listed"],
    },
    statement: { type: "string", description: "The one factual sentence: compared X against OFAC-SDN vintage V, and did / did not appear." },
    canonicalLeaf: { type: "string", description: "The exact JSON that was leaf-hashed." },
    disclaimer: { type: "string" },
  },
  required: ["attestation", "subject", "screenedAt", "method", "lists", "result", "statement", "disclaimer"],
} as const;

export const SCREEN_OFAC_OUTPUT_EXAMPLE = {
  attestation: {
    queryId: "21e9db64-1cec-49e6-9891-3402bb40db5f",
    canonVersion: "ofac-screen-v1",
    engineVersion: "sanction-screen-v1",
    leafHash: "cd890b5a640e37ae7e00983fd872f43daf7a88b52de3821d5bf1e23cb295c2a5",
    verify: "https://www.xrplhub.io/api/attest/verify?queryId=21e9db64-1cec-49e6-9891-3402bb40db5f",
  },
  subject: "rnXyVQzgxZe7TR1EPzTkGj2jxH4LMJYh66",
  screenedAt: "2026-09-07T06:08:41.368Z",
  method: "exact-match",
  ledgerIndex: 106817057,
  lists: [{ name: "OFAC-SDN", vintage: "2026-09-04", sha256: "97d98ef8f8273db9326e3e7beb4163d2d8a171f8a0d90fb628c488b53339d340" }],
  result: {
    listed: true,
    matches: [{ list: "OFAC-SDN", entryId: "33854", entryName: "CHATEX", addressField: "Digital Currency Address - XRP" }],
  },
  statement:
    "As of 2026-09-07T06:08:41.368Z, XRPL address rnXyVQzgxZe7TR1EPzTkGj2jxH4LMJYh66 was compared against the OFAC-SDN list, published version 2026-09-04 (file SHA-256 97d98ef8…d340), and appears on it as entry 33854 (CHATEX), field 'Digital Currency Address - XRP'.",
  canonicalLeaf: "{\"queryId\":\"21e9db64-…\",\"subjectAddress\":\"rnXyVQzgxZe7TR1EPzTkGj2jxH4LMJYh66\",…}",
  disclaimer: SCREEN_DISCLAIMER_SHORT,
};

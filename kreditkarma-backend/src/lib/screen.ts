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

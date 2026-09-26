// src/lib/ofac.ts
// Compatibility shim. OFAC SDN ingestion now lives in the generic, multi-list engine (src/lib/sanctionLists.ts) and the
// parser in src/lib/sanctionParsers.ts. Until 2026-09-25 this file extracted ONLY "Digital Currency Address - XRP" ids; it now
// archives every digital-currency address on the SDN list (per chain), while XRP Ledger screening behaves exactly as before.
// Older snapshots (archiveVersion 1, XRP only) stay in the database forever and remain valid for XRP-address screening.

import type { PrismaClient } from "@prisma/client";
import { LIST_CATALOG, currentSnapshot, peekStamp, refreshList, type RefreshResult } from "./sanctionLists";

export const OFAC_SDN_LIST_NAME = "OFAC-SDN";
export type { RefreshResult };

export function peekPublishDate(): Promise<string | null> {
  const info = LIST_CATALOG["OFAC-SDN"];
  return peekStamp(info.sourceUrl, info.peekPattern!);
}

export function refreshSdnSnapshot(prisma: PrismaClient): Promise<RefreshResult> {
  return refreshList(prisma, "OFAC-SDN");
}

export function currentSdnSnapshot(prisma: PrismaClient) {
  return currentSnapshot(prisma, "OFAC-SDN");
}

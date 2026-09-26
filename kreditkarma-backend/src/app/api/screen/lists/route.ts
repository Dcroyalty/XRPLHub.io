// src/app/api/screen/lists/route.ts
// GET /api/screen/lists — public, no key. Exactly which sanctions lists address screening runs against, what each REALLY contains,
// the version (vintage + content hash) currently in force, when we last confirmed it, which chains are covered, and what is not
// screened (and why). A compliance reviewer should be able to read this page and know precisely what a receipt can and cannot say.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { LIST_CATALOG, LIST_NAMES, UNSUPPORTED_LISTS_NOTE, currentSnapshot, lastChecked } from "@/lib/sanctionLists";
import { SUPPORTED_CHAINS, CHAIN_LABEL } from "@/lib/chainAddress";
import { SCREEN_CANON_SPEC_V2, SCREEN_ENGINE_VERSION } from "@/lib/screenCanon";
import { LIMITATIONS, RETENTION_VIEW } from "@/lib/screenView";
import { SCREEN_DISCLAIMER_SHORT } from "@/lib/screen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

export async function GET() {
  const lists = await Promise.all(
    LIST_NAMES.map(async (name) => {
      const i = LIST_CATALOG[name];
      const [snap, checkedAt] = await Promise.all([currentSnapshot(prisma, name), lastChecked(prisma, name)]);
      return {
        name,
        title: i.title,
        publisher: i.publisher,
        jurisdiction: i.jurisdiction,
        source: i.sourceUrl,
        whatItContains: i.addressContent,
        current: snap
          ? {
              vintage: snap.vintage,
              publishStamp: snap.publishRaw,
              sha256: snap.sha256,
              recordCount: snap.recordCount,
              addressCount: snap.addressCount,
              addressesByChain: snap.coverage,
              fetchedAt: snap.fetchedAt.toISOString(),
              lastConfirmedAt: (checkedAt && checkedAt > snap.fetchedAt ? checkedAt : snap.fetchedAt).toISOString(),
              unparsedAddressLikeStrings: snap.unparsedCount,
              archive: "retained forever; every receipt links to the exact archive it used",
            }
          : null,
      };
    })
  );
  const ready = lists.every((l) => l.current);
  return NextResponse.json(
    {
      ready,
      readyNote: ready ? "All lists are loaded." : "A list has no snapshot yet: screening is unavailable (503) rather than run against fewer lists.",
      lists,
      notScreened: [{ name: "UN-SC", why: UNSUPPORTED_LISTS_NOTE }],
      supportedChains: SUPPORTED_CHAINS.map((c) => ({ chain: c, label: CHAIN_LABEL[c] })),
      matching: "exact address-string match on the address's own chain; no name, alias or fuzzy matching",
      refresh: "daily (about 06:00 UTC); a publisher stamp/hash change creates a new immutable snapshot, an unchanged list is only re-confirmed",
      integrityGates: [
        "a snapshot below a size/record floor is refused",
        "a snapshot that lost more than 10% of records, or more than 40% of addresses, against the previous one is refused and alerted",
        "a snapshot with zero addresses when the previous one had some is refused",
        "an unchanged content hash is not stored twice",
        "address-like text we cannot verify by checksum is reported, never dropped silently",
      ],
      engine: { version: SCREEN_ENGINE_VERSION, rules: SCREEN_CANON_SPEC_V2.engine },
      retention: RETENTION_VIEW,
      limitations: LIMITATIONS,
      endpoints: {
        screen: "GET|POST /api/screen (API key)",
        batch: "POST /api/screen/batch — up to 100 addresses, one receipt each, one anchor batch (API key)",
        export: "GET /api/attest/export?from=&to=&format=json|csv (API key)",
        verify: "GET /api/attest/verify?queryId=",
        monitoring: "POST /api/monitor/subscribe — continuous re-screening; a `sanctions_hit` webhook fires when a watched address is newly listed",
      },
      terms: "https://www.xrplhub.io/legal/screening",
      disclaimer: SCREEN_DISCLAIMER_SHORT,
    },
    { headers: { "Cache-Control": "public, max-age=60" } }
  );
}

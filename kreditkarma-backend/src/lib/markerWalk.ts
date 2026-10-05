// src/lib/markerWalk.ts
// Node pinning for the resumable ledger_data walks (mptIndexer, credentialIndexer).
//
// A saved marker is only as good as the node it's resumed on. Verified 2026-10-04 against the
// live MPT checkpoint: xrplcluster (rippled) accepts a resumed marker that Ripple's s1/s2 (Clio)
// reject with markerDoesNotExist. So a walk always resumes on xrplcluster, falls back to another
// node only when xrplcluster can't be reached, and when a node rejects the marker it is handed to
// every other reachable node before the pass is restarted — a restart throws away every page the
// walk has made since the pass began, which at one bounded chunk a day can be weeks of progress.

import type { Client } from "xrpl";
import { connectMainnetOrThrow } from "./credentials";

/** xrplcluster first: the node that accepts resumed markers. Then Ripple's two, as fallbacks. */
export const MARKER_WALK_ENDPOINTS = [
  "wss://xrplcluster.com",
  "wss://s1.ripple.com",
  "wss://s2.ripple.com",
] as const;

/** A marker the current node can't use. rippled says "Invalid field 'marker'"; Clio says
 *  markerMalformed, or markerDoesNotExist for a well-formed marker it won't resume. */
export function isMarkerError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err);
  return /markerMalformed|markerDoesNotExist|invalid.*marker/i.test(msg);
}

/** Connect for a walk: xrplcluster, or the first reachable fallback if it's down. */
export function connectForWalk(): Promise<Client> {
  return connectMainnetOrThrow({ endpoints: MARKER_WALK_ENDPOINTS });
}

/**
 * The current node rejected the marker. Connect to the next reachable walk node not yet tried
 * for this marker (`tried` gets the current node's url added). Returns null when none is left —
 * only then should the caller restart the pass.
 */
export async function handOffMarker(current: Client, tried: Set<string>): Promise<Client | null> {
  tried.add(current.url);
  const remaining = MARKER_WALK_ENDPOINTS.filter((e) => !tried.has(e));
  if (!remaining.length) return null;
  const next = await connectMainnetOrThrow({ endpoints: remaining }).catch(() => null);
  if (!next) return null;
  await current.disconnect().catch(() => {});
  return next;
}

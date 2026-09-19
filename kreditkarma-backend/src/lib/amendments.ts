// src/lib/amendments.ts
// Amendment-state gate, generalised. One `ledger_entry` read of the singleton
// Amendments object (validated ledger) answers every amendment: the enabled
// list, plus `Majorities` (amendments that hold >80% support and are counting
// down the two-week hold).
//
// The answer is TRI-STATE — "active" | "inactive" | "unknown" — because the two
// consumers want opposite defaults when the ledger can't be read:
//   - Lending (lendingLedger.ts): fail CLOSED. Not-active-or-unknown => no-op.
//   - MPT permanence copy (mptPermanence.ts): fail toward the HEDGED wording.
//     "Unknown" must never be rendered as "permanent".
// A boolean can't express that, so callers compare `state` themselves.
//
// Caching follows what can change. Amendments cannot be disabled once enabled,
// so "active" is remembered forever. "inactive" can flip, so it lives for
// INACTIVE_TTL_MS; after that, if the ledger can't be re-read, the answer is
// "unknown" — a stale "inactive" is never served as fact.
//
// Reads go through xrplRpc (node rotation + cooldown + call counters), not a
// private fetch loop.

import { createHash } from "crypto";
import { xrplRpc } from "./xrplNodes";

export type AmendmentState = "active" | "inactive" | "unknown";

/** The fixed ledger index of the singleton Amendments object. */
export const AMENDMENTS_INDEX = "7DB0788C020F02780A673DC74757F23823FA3014C1866E72CC4CD8B226CD6EF4";

const RIPPLE_EPOCH_OFFSET = 946_684_800;
/** An amendment needs its majority held this long before it activates. */
const MAJORITY_HOLD_S = 14 * 24 * 60 * 60;
export const INACTIVE_TTL_MS = 10 * 60 * 1000;

/** SHA512-Half of the amendment name — its on-ledger id. */
export function amendmentId(name: string): string {
  return createHash("sha512").update(name, "utf8").digest("hex").slice(0, 64).toUpperCase();
}

export interface AmendmentSnapshot {
  ledgerIndex: number | null;
  readAt: number; // epoch ms
  enabled: ReadonlySet<string>;
  /** amendment id -> Ripple-epoch seconds at which >80% support was first held */
  majorities: ReadonlyMap<string, number>;
}
export type AmendmentReader = () => Promise<AmendmentSnapshot | null>;

export interface AmendmentStatus {
  name: string;
  id: string;
  state: AmendmentState;
  /** Validated ledger the answer was read from (null if unknown / remembered-active). */
  ledgerIndex: number | null;
  /** ISO time of the read the answer rests on (null when unknown). */
  checkedAt: string | null;
  /** Set while the amendment holds >80% support but is not yet enabled. */
  majoritySince: string | null;
  /** majoritySince + two weeks — the earliest the amendment can activate. */
  earliestActivation: string | null;
}

async function readFromLedger(): Promise<AmendmentSnapshot | null> {
  const r = await xrplRpc("ledger_entry", { index: AMENDMENTS_INDEX, ledger_index: "validated" });
  if (!r.ok) return null;
  const result = r.body.result as
    | {
        node?: {
          LedgerEntryType?: string;
          Amendments?: string[];
          Majorities?: { Majority?: { Amendment?: string; CloseTime?: number } }[];
        };
        ledger_index?: number;
      }
    | undefined;
  const node = result?.node;
  // Only a definitive Amendments object counts; an error body must not read as "nothing enabled".
  if (!node || node.LedgerEntryType !== "Amendments") return null;
  const majorities = new Map<string, number>();
  for (const m of node.Majorities ?? []) {
    const id = m.Majority?.Amendment;
    const t = m.Majority?.CloseTime;
    if (typeof id === "string" && typeof t === "number") majorities.set(id.toUpperCase(), t);
  }
  return {
    ledgerIndex: typeof result?.ledger_index === "number" ? result.ledger_index : null,
    readAt: Date.now(),
    enabled: new Set((node.Amendments ?? []).map((a) => a.toUpperCase())),
    majorities,
  };
}

let reader: AmendmentReader = readFromLedger;
let snapshot: AmendmentSnapshot | null = null;
const everEnabled = new Set<string>(); // monotonic: an enabled amendment stays enabled
let inflight: Promise<AmendmentSnapshot | null> | null = null;

async function currentSnapshot(): Promise<AmendmentSnapshot | null> {
  if (snapshot && Date.now() - snapshot.readAt < INACTIVE_TTL_MS) return snapshot;
  if (!inflight) {
    const p = (async () => {
      try {
        const s = await reader();
        if (s) {
          snapshot = s;
          for (const id of s.enabled) everEnabled.add(id);
        }
        return s;
      } catch {
        return null;
      }
    })();
    inflight = p;
    // Cleared from outside the async body so a reader that throws synchronously
    // can't clear `inflight` before it is assigned (which would pin it forever).
    void p.finally(() => {
      if (inflight === p) inflight = null;
    });
  }
  return inflight;
}

function statusFor(name: string, snap: AmendmentSnapshot | null): AmendmentStatus {
  const id = amendmentId(name);
  const base = { name, id, majoritySince: null, earliestActivation: null };
  if (everEnabled.has(id)) {
    return {
      ...base,
      state: "active",
      ledgerIndex: snap?.enabled.has(id) ? snap.ledgerIndex : null,
      checkedAt: snap?.enabled.has(id) ? new Date(snap.readAt).toISOString() : null,
    };
  }
  if (!snap) return { ...base, state: "unknown", ledgerIndex: null, checkedAt: null };
  const maj = snap.majorities.get(id);
  return {
    ...base,
    state: "inactive",
    ledgerIndex: snap.ledgerIndex,
    checkedAt: new Date(snap.readAt).toISOString(),
    majoritySince: maj != null ? new Date((maj + RIPPLE_EPOCH_OFFSET) * 1000).toISOString() : null,
    earliestActivation: maj != null ? new Date((maj + MAJORITY_HOLD_S + RIPPLE_EPOCH_OFFSET) * 1000).toISOString() : null,
  };
}

/** Status for several amendments from ONE ledger read. Never throws. */
export async function getAmendmentStatuses<N extends string>(names: readonly N[]): Promise<Record<N, AmendmentStatus>> {
  const snap = await currentSnapshot();
  const out = {} as Record<N, AmendmentStatus>;
  for (const n of names) out[n] = statusFor(n, snap);
  return out;
}

/** Status for one amendment. Never throws; "unknown" when the ledger can't be read. */
export async function getAmendmentStatus(name: string): Promise<AmendmentStatus> {
  return statusFor(name, await currentSnapshot());
}

/** Test-only: replace the ledger reader (null restores the real one). */
export function _setAmendmentReaderForTest(r: AmendmentReader | null): void {
  reader = r ?? readFromLedger;
}

/** Test-only: forget every cached answer. */
export function _resetAmendmentsForTest(): void {
  snapshot = null;
  inflight = null;
  everEnabled.clear();
}

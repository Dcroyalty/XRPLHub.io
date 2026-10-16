// src/lib/lendingTracker.ts — the XRPL Lending amendment tracker behind /lending.
//
// Two sources, each used for what it is the authority on:
//   • The XRP Ledger itself (the singleton Amendments object, via ./amendments): enabled or not, and the
//     date a >80% majority was first held. Nothing else can override this.
//   • XRPScan's validator registry (api.xrpscan.com, public, no key): the latest amendment votes each
//     validator published. Votes are not stored on the ledger — validators send them in their flag-ledger
//     validations — so a read-only site needs someone who listens to those. We only count validators on
//     Ripple's default list (vl.ripple.com), which is the list rippled's own majority rule uses by default.
//
// Votes needed = rippled's rule: more than 80% of trusted validators, i.e. floor(n × 0.8) + 1
// (29 of 35). An amendment then has to hold that majority for two straight weeks.
//
// One snapshot per hour (hourBucket is unique): a second call in the same hour returns the stored row, so the
// public trigger can't be used to hammer XRPScan or the database.

import type { PrismaClient } from "@prisma/client";
import { getAmendmentStatuses, amendmentId } from "./amendments";

export const LENDING_AMENDMENTS = ["LendingProtocol", "LendingProtocolV1_1", "SingleAssetVault"] as const;
export type LendingAmendment = (typeof LENDING_AMENDMENTS)[number];

/** What each amendment does, in one plain sentence. */
export const AMENDMENT_PLAIN: Record<LendingAmendment, string> = {
  SingleAssetVault: "Vaults: pools where people deposit one asset (XRP, RLUSD or another token) to be lent out.",
  LendingProtocol: "Loans: lets a vault's manager make fixed-term loans from the vault and collect repayments.",
  LendingProtocolV1_1: "Lending fixes and extensions to the first version, voted on separately.",
};

/** The exact sentence a person agrees to on the signup form; stored with each signup. */
export const LENDING_CONSENT = "Email me once when XRPL lending goes live on mainnet. One email, no marketing, unsubscribe any time.";

const XRPSCAN_REGISTRY = "https://api.xrpscan.com/api/v1/validatorregistry";
const DEFAULT_UNL = "vl.ripple.com";

export interface AmendmentRow {
  name: LendingAmendment;
  id: string;
  /** "active" = enabled on mainnet. "unknown" = the ledger couldn't be read this hour. */
  state: "active" | "inactive" | "unknown";
  yes: number | null; // default-list validators voting yes (null = vote data unavailable)
  needed: number | null; // votes needed for a majority
  unlSize: number | null;
  majoritySince: string | null;
  earliestActivation: string | null;
}
export interface VoterRow {
  key: string; // validator master public key
  domain: string | null;
  votes: Record<LendingAmendment, boolean>;
}
export interface TrackerSnapshot {
  takenAt: string;
  hourBucket: string;
  ledgerIndex: number | null;
  unlSize: number | null;
  source: "ledger+xrpscan" | "ledger-only";
  amendments: AmendmentRow[];
  voters: VoterRow[] | null;
}

export const votesNeeded = (unlSize: number) => Math.floor(unlSize * 0.8) + 1;

type RegistryEntry = { master_key?: string; domain?: string; unl?: string[]; chain?: string; last_seen?: string; votes?: { amendments?: string[] } };

/** Default-list validators and their votes. Null when XRPScan can't be read or looks wrong. */
export async function readValidatorVotes(): Promise<VoterRow[] | null> {
  try {
    const r = await fetch(XRPSCAN_REGISTRY, { headers: { "user-agent": "xrplhub-lending-tracker (+https://www.xrplhub.io/lending)" }, signal: AbortSignal.timeout(20_000), cache: "no-store" });
    if (!r.ok) return null;
    const list = (await r.json()) as RegistryEntry[];
    if (!Array.isArray(list)) return null;
    const ids = Object.fromEntries(LENDING_AMENDMENTS.map((n) => [n, amendmentId(n)])) as Record<LendingAmendment, string>;
    const unl = list.filter((v) => v.chain === "main" && Array.isArray(v.unl) && v.unl.includes(DEFAULT_UNL) && typeof v.master_key === "string");
    // The default list has had 30-40 validators for years; anything far outside that is a bad read, not news.
    if (unl.length < 20 || unl.length > 60) return null;
    return unl
      .map((v) => {
        const voted = new Set((v.votes?.amendments ?? []).map((a) => String(a).toUpperCase()));
        return {
          key: v.master_key as string,
          domain: v.domain || null,
          votes: Object.fromEntries(LENDING_AMENDMENTS.map((n) => [n, voted.has(ids[n])])) as Record<LendingAmendment, boolean>,
        };
      })
      .sort((a, b) => (a.domain ?? "~").localeCompare(b.domain ?? "~"));
  } catch {
    return null;
  }
}

export function hourBucket(d = new Date()): Date {
  const b = new Date(d);
  b.setUTCMinutes(0, 0, 0);
  return b;
}

/** Build a snapshot from the ledger + XRPScan. Never throws. */
export async function readTracker(): Promise<TrackerSnapshot> {
  const [statuses, voters] = await Promise.all([getAmendmentStatuses(LENDING_AMENDMENTS), readValidatorVotes()]);
  const unlSize = voters?.length ?? null;
  const amendments: AmendmentRow[] = LENDING_AMENDMENTS.map((name) => {
    const st = statuses[name];
    return {
      name,
      id: st.id,
      state: st.state,
      yes: voters ? voters.filter((v) => v.votes[name]).length : null,
      needed: unlSize ? votesNeeded(unlSize) : null,
      unlSize,
      majoritySince: st.majoritySince,
      earliestActivation: st.earliestActivation,
    };
  });
  const ledgerIndex = LENDING_AMENDMENTS.map((n) => statuses[n].ledgerIndex).find((x) => x != null) ?? null;
  const now = new Date();
  return {
    takenAt: now.toISOString(),
    hourBucket: hourBucket(now).toISOString(),
    ledgerIndex,
    unlSize,
    source: voters ? "ledger+xrpscan" : "ledger-only",
    amendments,
    voters,
  };
}

function fromRow(row: { takenAt: Date; hourBucket: Date; ledgerIndex: number | null; unlSize: number | null; data: string; voters: string | null; source: string }): TrackerSnapshot {
  return {
    takenAt: row.takenAt.toISOString(),
    hourBucket: row.hourBucket.toISOString(),
    ledgerIndex: row.ledgerIndex,
    unlSize: row.unlSize,
    source: row.source === "ledger+xrpscan" ? "ledger+xrpscan" : "ledger-only",
    amendments: JSON.parse(row.data) as AmendmentRow[],
    voters: row.voters ? (JSON.parse(row.voters) as VoterRow[]) : null,
  };
}

/**
 * The hourly job. Stores at most one snapshot per hour; a repeat call in the same hour returns the stored one
 * (`fresh: false`). A snapshot is only stored when the ledger was actually read — an "unknown" hour is not history.
 */
export async function runTracker(prisma: PrismaClient): Promise<{ fresh: boolean; snapshot: TrackerSnapshot; stored: boolean }> {
  const bucket = hourBucket();
  const existing = await prisma.lendingAmendmentSnapshot.findUnique({ where: { hourBucket: bucket } });
  if (existing) return { fresh: false, snapshot: fromRow(existing), stored: true };
  const snap = await readTracker();
  if (snap.amendments.some((a) => a.state === "unknown")) return { fresh: true, snapshot: snap, stored: false };
  try {
    await prisma.lendingAmendmentSnapshot.create({
      data: {
        hourBucket: bucket,
        ledgerIndex: snap.ledgerIndex,
        unlSize: snap.unlSize,
        data: JSON.stringify(snap.amendments),
        voters: snap.voters ? JSON.stringify(snap.voters) : null,
        source: snap.source,
      },
    });
  } catch (e) {
    // Two calls racing on the same hour: the other one stored it.
    const again = await prisma.lendingAmendmentSnapshot.findUnique({ where: { hourBucket: bucket } });
    if (again) return { fresh: false, snapshot: fromRow(again), stored: true };
    throw e;
  }
  return { fresh: true, snapshot: snap, stored: true };
}

export async function latestSnapshot(prisma: PrismaClient): Promise<TrackerSnapshot | null> {
  const row = await prisma.lendingAmendmentSnapshot.findFirst({ orderBy: { hourBucket: "desc" } });
  return row ? fromRow(row) : null;
}

export interface SeriesPoint {
  at: string;
  yes: Partial<Record<LendingAmendment, number>>;
  needed: number | null;
}

/** Yes-vote history for the chart: one point per day (the day's last snapshot) plus every snapshot of the last 48 h. */
export async function voteSeries(prisma: PrismaClient, days = 120): Promise<SeriesPoint[]> {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await prisma.lendingAmendmentSnapshot.findMany({
    where: { hourBucket: { gte: since }, source: "ledger+xrpscan" },
    orderBy: { hourBucket: "asc" },
    select: { hourBucket: true, data: true },
  });
  const recentCut = Date.now() - 48 * 3_600_000;
  const byDay = new Map<string, (typeof rows)[number]>();
  const recent: (typeof rows)[number][] = [];
  for (const r of rows) {
    if (r.hourBucket.getTime() >= recentCut) recent.push(r);
    else byDay.set(r.hourBucket.toISOString().slice(0, 10), r);
  }
  return [...byDay.values(), ...recent].map((r) => {
    const a = JSON.parse(r.data) as AmendmentRow[];
    return {
      at: r.hourBucket.toISOString(),
      yes: Object.fromEntries(a.filter((x) => x.yes != null).map((x) => [x.name, x.yes as number])),
      needed: a.find((x) => x.needed != null)?.needed ?? null,
    };
  });
}

/** True once every amendment phase 2 depends on is enabled on mainnet (read from the ledger, never a flag). */
export async function lendingLive(): Promise<boolean> {
  const s = await getAmendmentStatuses(["LendingProtocol", "SingleAssetVault"] as const);
  return s.LendingProtocol.state === "active" && s.SingleAssetVault.state === "active";
}

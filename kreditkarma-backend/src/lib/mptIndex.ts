// src/lib/mptIndex.ts
// Shared helpers for the MPTokenIssuance registry (XLS-33): deriving the
// canonical 48-hex MPTokenIssuanceID, shaping an IndexedMPT row from either
// source (our ledger_data walk or Bithomp's per-issuer index), and the
// coverage signal every indexed response must carry.
//
// Consumed by src/lib/mptIndexer.ts (the bounded cron pass), scripts/census-
// mpts.cjs mirrors this logic in plain JS, and the read routes
// (/api/mpt/search, /api/mpt/issuer).

import { createHash } from "crypto";
import { convertHexToString, decodeAccountID } from "xrpl";
import type { PrismaClient } from "@prisma/client";
import type { BithompMpt } from "./bithomp";

// The union of MPT issuers established by the reconciliation (our state walk +
// Bithomp's index): 34 addresses. Seeds the first cron run; after that the
// issuer list is read from the DB and this is just a floor.
export const MPT_BOOTSTRAP_ISSUERS: readonly string[] = [
  "rM7ffj9GZV41K8fWUhtpfZSZvYoZB2yA4t", "rPm6K1fr4MNcv5W8pD4RCawVHjsK1ziCKp",
  "rLKfWwLeimLe69mrTr3MygNavDxL8tjuUX", "rinAXYBnAf1xeSZGaZ28EVQVQvxYj2Wex",
  "rMi1UL1joGAn3rH6Cu9GDiTeErFx8Pc33H", "rsiPEXNs1XGn14DV7MHXsTfQVpGiEpJ347",
  "r9ASYAPBCyzW5zEy5H4e66t2oigUdZN14p", "rULZPkxia4xpYtb9rEJUsHenmWAMZfwAzp",
  "rGJdc5PUa5dGE6BiDcufXyU9BDSQ4Zg2r8", "r3hcwikU3XyAXX9969oRzDJm7B5hepfXGe",
  "rBJ2ogWEZvsxkuK7aV4k6H9VAto7k2SsH9", "rHCx2zWMN1r9yB78mtNX9bUUHCL5eMYHUR",
  "raFWVyTwpks1hd2rEbi85AtPPnJ3DuwrA9", "rGxUbYEHnmiJ55e5hKuJ9m7dthdJHSx5vz",
  "rPgswA5wCM6wvtzsNd7oQa6r3UK5YT6om9", "r9o37ZXw3VQyvZzYk4p6wEgGZhH14mHmr2",
  "r4WkNmYkB1M5hcZF3vYLfiLseJfKvgkFyA", "rKSg2VZbw9gRRuSwBjBFAfBoGC5Vs1FmFn",
  "rEkGNmAo4R7KfA6wZre62LJXDUvmtgg66i", "rJyNbUbcvP19KYwMq2bPnvYQNwUY2ZQrWZ",
  "rJnCt4Mm826qSA6jc4WqwmrpwPxBBgLfwp", "rswtXJQkf1kMzrZn1xho1KrkfcsCa2nNAv",
  "rNyrL3hjvM3mDYtTDhHLWMiGtbnV2wdBv6", "rfXMq3BMX2dTzJtG4pnhr49u6sHkVQXpWL",
  "r9avT7NURuqC7jbVxUjcrMkHAr5aqmHkSN", "rMzydKJUk5tUq3ZuVQGNaRJMh9TQ624PML",
  "r3iMKCiKqu522oRGQcAdyvwoRUaTn7s8fi", "rLm3recAhoqwfnU4HF2RybjALBXVvhJ2Ku",
  "rwA8orrVtNPuBykRvQdDJzRDQbe7CuxCiR", "rUxiSsPXBhBRznVarw3Vu1Rss8FhHEnDg",
  "rs2uGjFkNAdLJgoLytQVXrqwbwjLoU3BT6", "rK5pfemxwpe2ioXKSdqnQaYCZ6NeKkgouv",
  "rtsTmBYcMGoNuPV6TBGU9gMhzn5vsVNsa", "rLr3ZxWy7owtSwaCH2n7tCauQENrt9MVgU",
];

export const MPT_CHECKPOINT_ID = "mpt";

// MPTokenIssuance Flags (XLS-33)
const FLAG = {
  locked: 0x0001,
  canLock: 0x0002,
  requireAuth: 0x0004,
  canEscrow: 0x0008,
  canTrade: 0x0010,
  canTransfer: 0x0020,
  canClawback: 0x0040,
} as const;

function safeDecode(hex: string): string {
  try {
    return convertHexToString(hex);
  } catch {
    return hex;
  }
}

/**
 * MPTokenIssuanceID = the 192-bit plain concatenation of the creating
 * transaction's Sequence (32 bits, big-endian) and the issuer's AccountID
 * (160 bits) — NOT hashed. 48 uppercase hex chars. (The ledger *object* key is
 * a separate SHA-512Half; this is the id used in ledger_entry's mpt_issuance
 * shorthand and everywhere Bithomp/explorers refer to an issuance.)
 */
export function deriveMptIssuanceId(sequence: number, issuer: string): string {
  const seqHex = (sequence >>> 0).toString(16).toUpperCase().padStart(8, "0");
  const acctHex = Buffer.from(decodeAccountID(issuer)).toString("hex").toUpperCase();
  return seqHex + acctHex; // 8 + 40 = 48
}

export interface MptRowInput {
  issuanceId: string;
  issuer: string;
  sequence: number | null;
  assetScale: number;
  maxAmount: string | null;
  outstanding: string;
  transferFee: number; // raw (tenths of a bp)
  flagsRaw: number;
  metadata: string | null; // decoded JSON string or raw text
  name: string | null;
  holderCount: number | null;
  ledgerIndex: number | null;
  source: "walk" | "bithomp";
}

function nameFromMetadata(meta: string | null): string | null {
  if (!meta) return null;
  try {
    const o = JSON.parse(meta) as Record<string, unknown>;
    const n = o.name ?? o.ticker ?? o.currency ?? o.n ?? o.t;
    return typeof n === "string" && n.trim() ? n.trim() : null;
  } catch {
    return null;
  }
}

/** Shape a row from a raw ledger_data / ledger_entry MPTokenIssuance node. */
export function mptRowFromLedgerNode(node: Record<string, unknown>): MptRowInput {
  const issuer = String(node.Issuer ?? "");
  const sequence = typeof node.Sequence === "number" ? node.Sequence : null;
  const metaHex = typeof node.MPTokenMetadata === "string" ? node.MPTokenMetadata : null;
  const metadata = metaHex ? safeDecode(metaHex) : null;
  const issuanceId =
    typeof node.mpt_issuance_id === "string"
      ? String(node.mpt_issuance_id).toUpperCase()
      : sequence != null && issuer
      ? deriveMptIssuanceId(sequence, issuer)
      : "";
  return {
    issuanceId,
    issuer,
    sequence,
    assetScale: Number(node.AssetScale ?? 0),
    maxAmount: node.MaximumAmount != null ? String(node.MaximumAmount) : null,
    outstanding: String(node.OutstandingAmount ?? "0"),
    transferFee: Number(node.TransferFee ?? 0),
    flagsRaw: Number(node.Flags ?? 0),
    metadata,
    name: nameFromMetadata(metadata),
    holderCount: null,
    ledgerIndex: null,
    source: "walk",
  };
}

/** Shape a row from a Bithomp per-issuer issuance object. */
export function mptRowFromBithomp(b: BithompMpt): MptRowInput {
  const metadata = b.metadata ? JSON.stringify(b.metadata) : null;
  let flagsRaw = 0;
  if (b.flags) {
    if (b.flags.locked) flagsRaw |= FLAG.locked;
    if (b.flags.canLock) flagsRaw |= FLAG.canLock;
    if (b.flags.requireAuth) flagsRaw |= FLAG.requireAuth;
    if (b.flags.canEscrow) flagsRaw |= FLAG.canEscrow;
    if (b.flags.canTrade) flagsRaw |= FLAG.canTrade;
    if (b.flags.canTransfer) flagsRaw |= FLAG.canTransfer;
    if (b.flags.canClawback) flagsRaw |= FLAG.canClawback;
  }
  const name =
    (b.metadata && typeof b.metadata.name === "string" && b.metadata.name) ||
    (b.metadata && typeof b.metadata.ticker === "string" && b.metadata.ticker) ||
    b.currency ||
    null;
  return {
    issuanceId: String(b.mptokenIssuanceID).toUpperCase(),
    issuer: String(b.issuer ?? ""),
    sequence: typeof b.sequence === "number" ? b.sequence : null,
    assetScale: typeof b.scale === "number" ? b.scale : 0,
    maxAmount: b.maximumAmount != null ? String(b.maximumAmount) : null,
    outstanding: b.outstandingAmount != null ? String(b.outstandingAmount) : "0",
    transferFee: typeof b.transferFee === "number" ? b.transferFee : 0,
    flagsRaw,
    metadata,
    name: name ? String(name).trim() || null : null,
    holderCount: typeof b.holders === "number" ? b.holders : typeof b.mptokens === "number" ? b.mptokens : null,
    ledgerIndex: null,
    source: "bithomp",
  };
}

/** Decode flagsRaw into the human-facing issuer-power booleans. */
export function decodeMptFlags(flagsRaw: number) {
  return {
    currentlyFrozen: (flagsRaw & FLAG.locked) !== 0,
    canFreeze: (flagsRaw & FLAG.canLock) !== 0,
    requiresAuth: (flagsRaw & FLAG.requireAuth) !== 0,
    canEscrow: (flagsRaw & FLAG.canEscrow) !== 0,
    canTrade: (flagsRaw & FLAG.canTrade) !== 0,
    transferable: (flagsRaw & FLAG.canTransfer) !== 0,
    clawback: (flagsRaw & FLAG.canClawback) !== 0,
  };
}

export function issuanceIdsHash(ids: string[]): string {
  return createHash("sha256").update([...ids].sort().join(",")).digest("hex");
}

export type Coverage = "complete" | "partial";

export interface CoverageInfo {
  coverage: Coverage;
  lastCompletedPassAt: string | null;
  indexedIssuances: number;
  indexedIssuers: number;
  note: string;
}

/**
 * The honesty block. `coverage` is "complete" only once our own ledger_data
 * walk has finished a full pass — until then the index is the Bithomp union
 * plus however far the walk has got, and callers must not read it as the
 * whole population.
 */
export async function mptCoverage(prisma: PrismaClient): Promise<CoverageInfo> {
  const [cp, issuanceCount, issuerRows] = await Promise.all([
    prisma.indexerCheckpoint.findUnique({ where: { id: MPT_CHECKPOINT_ID } }),
    prisma.indexedMPT.count(),
    prisma.indexedMPT.findMany({ select: { issuer: true }, distinct: ["issuer"] }),
  ]);
  const complete = !!cp?.lastCompletedPassAt;
  return {
    coverage: complete ? "complete" : "partial",
    lastCompletedPassAt: cp?.lastCompletedPassAt ? cp.lastCompletedPassAt.toISOString() : null,
    indexedIssuances: issuanceCount,
    indexedIssuers: issuerRows.length,
    note: complete
      ? "Our network-wide ledger_data walk has completed at least one full pass; this index reflects every MPTokenIssuance on the ledger as of that pass, refreshed daily."
      : "Our network-wide ledger_data walk has not finished a full pass yet. This index is the reconciled Bithomp union plus however far the walk has got — treat it as a floor, not the whole population.",
  };
}

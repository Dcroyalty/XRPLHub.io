// src/lib/mptAnchor.ts
// On-ledger anchoring of the MPT registry — BIS Working Paper 1374 pattern:
// commit a Merkle root of the canonicalised index in a Memo on a transaction
// so anyone can later prove the published registry wasn't altered after.
//
// SIGNING KEY: a DEDICATED anchor wallet (ANCHOR_WALLET_SEED), NOT the
// credential issuer. The anchor key can only publish memos; if the serverless
// env is compromised the blast radius is fake anchors (recoverable), never a
// forged XRPLHub credential. The credential issuer seed never touches Vercel.
//
// The canonicalisation and Merkle scheme below are FROZEN under CANON_VERSION.
// GET /api/mpt/anchor echoes this exact description so a third party can
// recompute the root from the published rows and check it against the memo.

import { createHash } from "crypto";
import { Wallet } from "xrpl";
import type { PrismaClient } from "@prisma/client";
import { connectMainnetOrThrow } from "./credentials";

export const CANON_VERSION = "mpt-anchor-v1";

// The dedicated anchor account. Verifiers trust roots ONLY from this address.
// It is deliberately NOT rmWjCGeLtuLGerEuvHDkrsr46ej2Ni13f (the credential
// issuer) — a compromised anchor key cannot mint credentials.
export const ANCHOR_ACCOUNT = "r9dQS1oGms3B7SdY6nyU24Dy7dWyWXuJXb";

export const CANON_SPEC = {
  version: CANON_VERSION,
  record: {
    description:
      "For every row in the MPT registry, build a JSON object with EXACTLY these keys in this order, " +
      "then serialise with JSON.stringify and no extra whitespace (UTF-8 bytes).",
    keys: [
      "issuanceId",       // 48-char uppercase hex MPTokenIssuanceID
      "issuer",           // r-address
      "sequence",         // integer, or null
      "assetScale",       // integer
      "maximumAmount",    // decimal string, or null (unlimited)
      "outstandingAmount",// decimal string
      "transferFee",      // integer, raw TransferFee (tenths of a basis point)
      "flags",            // integer, raw MPTokenIssuance Flags
      "metadataSha256",   // lowercase hex SHA-256 of the raw decoded MPTokenMetadata string, or null
      "name",             // string, or null
      "ticker",           // string, or null
      "holderCount",      // integer, or null
      "sources",          // array of strings, sorted ascending ("bithomp","walk")
    ],
  },
  leaves:
    "Sort the record JSON strings by their issuanceId ascending (byte order). " +
    "Leaf hash = SHA-256( 0x00 || utf8(recordJson) ).",
  merkle:
    "RFC 6962 style. Internal node = SHA-256( 0x01 || left || right ). At a level with an odd number of " +
    "nodes, the last node is promoted unchanged to the next level. A single-leaf tree's root is that leaf " +
    "hash. The empty tree's root is SHA-256 of the empty string.",
  root: "Lowercase 64-char hex.",
} as const;

const SHA0 = Buffer.from([0x00]);
const SHA1 = Buffer.from([0x01]);
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest();
const sha256hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

export interface CanonRecord {
  issuanceId: string;
  issuer: string;
  sequence: number | null;
  assetScale: number;
  maximumAmount: string | null;
  outstandingAmount: string;
  transferFee: number;
  flags: number;
  metadataSha256: string | null;
  name: string | null;
  ticker: string | null;
  holderCount: number | null;
  sources: string[];
}

/** Build the canonical record for one IndexedMPT row — key order is load-bearing. */
export function canonRecord(row: {
  issuanceId: string; issuer: string; sequence: number | null; assetScale: number;
  maxAmount: string | null; outstanding: string; transferFee: number; flagsRaw: number;
  metadata: string | null; name: string | null; ticker: string | null; holderCount: number | null;
  sources: string;
}): CanonRecord {
  return {
    issuanceId: row.issuanceId.toUpperCase(),
    issuer: row.issuer,
    sequence: row.sequence ?? null,
    assetScale: row.assetScale ?? 0,
    maximumAmount: row.maxAmount ?? null,
    outstandingAmount: row.outstanding ?? "0",
    transferFee: row.transferFee ?? 0,
    flags: row.flagsRaw ?? 0,
    metadataSha256: row.metadata ? sha256hex(row.metadata) : null,
    name: row.name ?? null,
    ticker: row.ticker ?? null,
    holderCount: row.holderCount ?? null,
    sources: (row.sources ?? "").split(",").filter(Boolean).sort(),
  };
}

/** Deterministic serialisation — explicit key order (JS preserves string-key
 *  insertion order), JSON.stringify default (no whitespace). */
export function canonJson(r: CanonRecord): string {
  return JSON.stringify({
    issuanceId: r.issuanceId,
    issuer: r.issuer,
    sequence: r.sequence,
    assetScale: r.assetScale,
    maximumAmount: r.maximumAmount,
    outstandingAmount: r.outstandingAmount,
    transferFee: r.transferFee,
    flags: r.flags,
    metadataSha256: r.metadataSha256,
    name: r.name,
    ticker: r.ticker,
    holderCount: r.holderCount,
    sources: r.sources,
  });
}

export function merkleRoot(leafJsons: string[]): string {
  if (leafJsons.length === 0) return createHash("sha256").update("").digest("hex");
  let level: Buffer[] = leafJsons.map((j) => sha256(Buffer.concat([SHA0, Buffer.from(j, "utf8")])));
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        next.push(sha256(Buffer.concat([SHA1, level[i], level[i + 1]])));
      } else {
        next.push(level[i]); // odd node promoted unchanged
      }
    }
    level = next;
  }
  return level[0].toString("hex");
}

export interface RegistrySnapshot {
  merkleRoot: string;
  issuanceCount: number;
  issuerCount: number;
  records: CanonRecord[]; // sorted by issuanceId
}

/** Canonicalise the whole IndexedMPT table and compute its Merkle root. */
export async function computeRegistrySnapshot(prisma: PrismaClient): Promise<RegistrySnapshot> {
  const rows = await prisma.indexedMPT.findMany();
  const records = rows.map(canonRecord).sort((a, b) => (a.issuanceId < b.issuanceId ? -1 : a.issuanceId > b.issuanceId ? 1 : 0));
  const jsons = records.map(canonJson);
  const issuers = new Set(records.map((r) => r.issuer));
  return {
    merkleRoot: merkleRoot(jsons),
    issuanceCount: records.length,
    issuerCount: issuers.size,
    records,
  };
}

const MEMO_TYPE = `XRPLHub-MPT-Registry-Anchor/${CANON_VERSION}`;
const toHex = (s: string) => Buffer.from(s, "utf8").toString("hex").toUpperCase();

export interface AnchorMemoPayload {
  root: string;
  issuances: number;
  issuers: number;
  coverage: string;
  freshnessFloor: string | null;
  ts: string;
}

export function buildAnchorMemo(p: AnchorMemoPayload) {
  const data = JSON.stringify(p);
  return {
    memoData: data,
    Memos: [{
      Memo: {
        MemoType: toHex(MEMO_TYPE),
        MemoFormat: toHex("application/json"),
        MemoData: toHex(data),
      },
    }],
  };
}

export function anchorSigningKeyPresent(): boolean {
  return !!process.env.ANCHOR_WALLET_SEED;
}

/**
 * Submit one anchor transaction from the DEDICATED anchor wallet. AccountSet
 * with no settings — nothing moves, it just carries the Memo and costs the
 * base fee (~10 drops). Requires ANCHOR_WALLET_SEED (must derive
 * ANCHOR_ACCOUNT). The credential issuer seed is never used here.
 */
export async function submitAnchorTx(payload: AnchorMemoPayload): Promise<{
  txHash: string; ledgerIndex: number; account: string; feeDrops: string; validated: boolean; engineResult: string;
}> {
  const seed = process.env.ANCHOR_WALLET_SEED;
  if (!seed) throw new Error("ANCHOR_WALLET_SEED not set — cannot sign the anchor.");
  const wallet = Wallet.fromSeed(seed);
  if (wallet.classicAddress !== ANCHOR_ACCOUNT) {
    throw new Error(`REFUSING: ANCHOR_WALLET_SEED derives ${wallet.classicAddress}, expected ${ANCHOR_ACCOUNT}.`);
  }
  const { Memos } = buildAnchorMemo(payload);
  const client = await connectMainnetOrThrow();
  try {
    const prepared = await client.autofill({
      TransactionType: "AccountSet",
      Account: wallet.classicAddress,
      Memos,
    } as unknown as Parameters<typeof client.autofill>[0]);
    const signed = wallet.sign(prepared);
    const res = await client.submitAndWait(signed.tx_blob);
    const meta = res.result.meta;
    const engineResult =
      meta && typeof meta === "object" ? (meta as { TransactionResult: string }).TransactionResult : "unknown";
    return {
      txHash: res.result.hash,
      ledgerIndex: res.result.ledger_index ?? 0,
      account: wallet.classicAddress,
      feeDrops: (prepared as { Fee?: string }).Fee ?? "",
      validated: res.result.validated ?? false,
      engineResult,
    };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

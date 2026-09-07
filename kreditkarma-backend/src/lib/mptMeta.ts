// src/lib/mptMeta.ts
// Assemble and parse the MPTokenMetadata blob for MPTokenIssuanceCreate.
//
// Shape (JSON, then hex; the whole thing must be <= 1024 bytes on-ledger):
//   {
//     "ticker": "ACME",
//     "name": "ACME Points",
//     "weblink": "https://acme.example",         // optional
//     "backing": { backingType, backingStatement, verifiedBy, redeemable }
//   }
// `backing` is a TOP-LEVEL key so any third-party explorer can read it, not just
// XRPLHub. The 4 field names match the form and every API response verbatim.

import { normalizeBacking, BACKING_HARD_LINE, type BackingDeclaration } from "./mptBacking";
import { explainMptFlags } from "./mptFlags";
import { convertHexToString } from "xrpl";

export interface MptMetadataInput {
  name: string;
  ticker: string;
  weblink?: string;
  backing: BackingDeclaration;
}

export interface ParsedMptMetadata {
  name: string | null;
  ticker: string | null;
  weblink: string | null;
  backing: BackingDeclaration | null;
  raw: unknown;
}

export function buildMptMetadata(input: MptMetadataInput): { json: string; hex: string; bytes: number } {
  const obj: Record<string, unknown> = {
    ticker: input.ticker,
    name: input.name,
  };
  if (input.weblink) obj.weblink = input.weblink;
  obj.backing = {
    backingType: input.backing.backingType,
    backingStatement: input.backing.backingStatement,
    verifiedBy: input.backing.verifiedBy,
    redeemable: input.backing.redeemable,
  };
  const json = JSON.stringify(obj);
  const hex = Buffer.from(json, "utf8").toString("hex").toUpperCase();
  return { json, hex, bytes: hex.length / 2 };
}

// ── The manifest — shown in the free preview AND the paid confirmation step ────

export interface MptIssuanceManifest {
  transactionType: "MPTokenIssuanceCreate";
  issuer: string;
  ticker: string | null;
  name: string | null;
  maximumSupply: string;
  assetScale: number;
  transferFeePercent: number | null;
  metadata: ParsedMptMetadata;
  flags: {
    value: number;
    issuerPowersGranted: string[];
    issuerPowersNotGranted: string[];
    holderCapabilities: string[];
  };
  backingDeclaration: BackingDeclaration | null;
  irreversible: string[];
  costs: { ownerReserveXrpLocked: number; transactionFeeXrp: number; reserveReclaimable: string };
  notMinted: string;
  hardLine: { flags: string; backing: string };
}

/** Describe an already-built MPTokenIssuanceCreate txjson in plain English. */
export function describeMptIssuanceCreate(txjson: Record<string, unknown>): MptIssuanceManifest {
  const flagsRaw = Number(txjson.Flags ?? 0);
  const exp = explainMptFlags(flagsRaw);
  const metaHex = typeof txjson.MPTokenMetadata === "string" ? txjson.MPTokenMetadata : null;
  let decoded: string | null = null;
  if (metaHex) {
    try {
      decoded = convertHexToString(metaHex);
    } catch {
      decoded = null;
    }
  }
  const meta = parseMptMetadata(decoded);
  const transferFee = txjson.TransferFee != null ? Number(txjson.TransferFee) : null;

  const irreversible: string[] = [
    "All six capability flags are set once, here, and can NEVER be changed. DynamicMPT is not enabled on mainnet.",
    ...exp.set.map((f) => `PERMANENT — ${f.label}: ${f.plain}`),
    ...exp.issuerPowersNotGranted,
    "The maximum supply, decimal scale, transfer fee, and this metadata (including the backing declaration) are fixed forever.",
    "The MPTokenIssuanceID is permanently tied to your account. The issuance can only be destroyed if zero tokens are ever outstanding.",
  ];

  return {
    transactionType: "MPTokenIssuanceCreate",
    issuer: String(txjson.Account ?? ""),
    ticker: meta.ticker,
    name: meta.name,
    maximumSupply: String(txjson.MaximumAmount ?? ""),
    assetScale: Number(txjson.AssetScale ?? 0),
    transferFeePercent: transferFee != null ? transferFee / 1000 : null,
    metadata: meta,
    flags: {
      value: flagsRaw,
      issuerPowersGranted: exp.issuerPowersGranted,
      issuerPowersNotGranted: exp.issuerPowersNotGranted,
      holderCapabilities: exp.set.filter((f) => f.category === "holder-capability").map((f) => f.plain),
    },
    backingDeclaration: meta.backing,
    irreversible,
    costs: {
      ownerReserveXrpLocked: 0.2,
      transactionFeeXrp: 0.00001,
      reserveReclaimable:
        "The 0.2 XRP owner reserve is only reclaimable if OutstandingAmount returns to 0 and you submit MPTokenIssuanceDestroy. Once tokens circulate it is effectively permanent.",
    },
    notMinted:
      "Creating the issuance mints ZERO tokens. You put supply into circulation later by sending Payments of the token to holders (the Send MPT service).",
    hardLine: {
      flags:
        "These flags are the issuer's power over holders. Nobody else explains them. Clawback means you can take the token back from anyone. Set them deliberately — this is the only chance.",
      backing: BACKING_HARD_LINE,
    },
  };
}

export function parseMptMetadata(decoded: string | null): ParsedMptMetadata {
  if (!decoded) return { name: null, ticker: null, weblink: null, backing: null, raw: null };
  let raw: unknown;
  try {
    raw = JSON.parse(decoded);
  } catch {
    return { name: null, ticker: null, weblink: null, backing: null, raw: decoded };
  }
  const o = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const b = o.backing as Record<string, unknown> | undefined;
  return {
    name: str(o.name) ?? str(o.n),
    ticker: str(o.ticker) ?? str(o.currency) ?? str(o.t),
    weblink: str(o.weblink) ?? str(o.url) ?? str(o.web),
    backing: b
      ? normalizeBacking({
          backingType: b.backingType as BackingDeclaration["backingType"],
          backingStatement: typeof b.backingStatement === "string" ? b.backingStatement : "",
          verifiedBy: typeof b.verifiedBy === "string" ? b.verifiedBy : null,
          redeemable: b.redeemable as BackingDeclaration["redeemable"],
        })
      : null,
    raw,
  };
}

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
import {
  ALWAYS_PERMANENT,
  amendmentEvidence,
  changeableLines,
  confirmCopy,
  decodeImmutableFlags,
  lockGuide,
  regimeHeadline,
  type MptRegimeView,
} from "./mptPermanence";
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
  /** Which permanence regime these lines were written for, and the live amendment read behind it. */
  permanence: {
    regime: MptRegimeView["regime"];
    amendment: ReturnType<typeof amendmentEvidence>;
    /** Items this transaction locks with ImmutableFlags (empty unless DynamicMPT is active). */
    lockedByThisTransaction: string[];
  };
  /** Kept under its original name: the lines the confirmation UI lists. It is
   *  NOT all irreversible any more — each line says which it is. */
  irreversible: string[];
  costs: { ownerReserveXrpLocked: number; transactionFeeXrp: number; reserveReclaimable: string };
  notMinted: string;
  hardLine: { flags: string; backing: string };
}

/**
 * Describe an already-built MPTokenIssuanceCreate txjson in plain English, for the
 * permanence regime `view` (from getMptRegimeView() — a live amendment read).
 */
export function describeMptIssuanceCreate(txjson: Record<string, unknown>, view: MptRegimeView): MptIssuanceManifest {
  const flagsRaw = Number(txjson.Flags ?? 0);
  const exp = explainMptFlags(flagsRaw, view.regime);
  const locks = decodeImmutableFlags(Number(txjson.ImmutableFlags ?? 0)).locked;
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

  // Each line says whether it is permanent, locked, or changeable — nothing here
  // may say "can never be changed" about an item without a regime (see mptFlags.ts).
  const irreversible: string[] = [
    ...regimeHeadline(view),
    ...ALWAYS_PERMANENT.map((l) => `PERMANENT — ${l}`),
    ...exp.set.map((f) => `PERMANENT (flag on) — ${f.label}: ${f.plain}`),
    // Per-flag lines stay short: the regime-specific "Flags left OFF" line below carries the
    // conditional once, instead of repeating it for every flag.
    ...exp.unset.map((f) => `OFF — ${f.label}: ${f.ifEnabledLater}`),
    ...changeableLines(view, { transferFeeSet: transferFee != null && transferFee > 0 }),
    ...locks.map((i) => `LOCKED by this transaction — ${i.label} (${i.tif}): can never change after you sign.`),
    ...lockGuide(view),
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
    permanence: {
      regime: view.regime,
      amendment: amendmentEvidence(view),
      lockedByThisTransaction: locks.map((i) => i.key),
    },
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
      flags: confirmCopy(view, locks.map((i) => i.key)).hardLineFlags,
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

// src/lib/credentials.ts
// ─────────────────────────────────────────────────────────────────────────────
// DEVNET-ONLY proof of concept — XRPLScore as native XLS-70 Credentials.
//
// XLS-70 credentials carry no numeric value field, so XRPLScore ships as a
// TIERED credential. CredentialType strings are frozen in docs/CREDENTIAL-SPEC.md:
//   io.xrplhub.score.v1.min600 / .min650 / .min700 / .min750
// A PermissionedDomain / lending vault gates on the (Issuer, CredentialType) pair.
// A wallet receives ONLY its highest qualifying tier (see the spec).
//
// ── SAFETY: this file can only ever touch Devnet ──────────────────────────────
//  * The endpoint is a hardcoded const — never read from an env var, never a
//    function parameter.
//  * Every connection is verified against Devnet's network_id (2) via BOTH
//    client.networkID and server_info before ANY transaction is signed. A
//    mismatch throws before signing — there is no code path to mainnet/testnet.
//  * The only secret consumed is DEVNET_CREDENTIAL_ISSUER_SEED.
// ─────────────────────────────────────────────────────────────────────────────

import {
  Client,
  Wallet,
  convertStringToHex,
  convertHexToString,
  unixTimeToRippleTime,
  rippleTimeToUnixTime,
  type SubmittableTransaction,
  type LedgerEntryRequest,
} from "xrpl";
import { scoreWallet, AccountNotFoundError } from "./xrplscore";

// ── HARD DEVNET LOCK ─────────────────────────────────────────────────────────
export const DEVNET_WSS = "wss://s.devnet.rippletest.net:51233";
export const DEVNET_NETWORK_ID = 2; // mainnet=0, testnet=1, devnet=2
const VALIDITY_DAYS = 90;

// FROZEN — see docs/CREDENTIAL-SPEC.md. Do not change without a v2 namespace.
export const CRED_NAMESPACE = "io.xrplhub.score.v1";

// The URI points at the existing mainnet verification surface (off-ledger).
const PUBLIC_ORIGIN = "https://www.xrplhub.io";
const MAX_URI_HEX = 256; // xrpl.js MAX_URI_LENGTH (128 bytes)

// Only POSITIVE tiers are ever issued. A failing score gets NO credential:
// a public on-chain negative attestation would never be accepted, so the
// issuer would carry the 0.2 XRP reserve forever on an object that also
// insults the subject. Below 600 (and unscored) -> "not eligible", no tx.
export type ScoreTier = "min750" | "min700" | "min650" | "min600";

export const ELIGIBILITY_FLOOR = 600;

/** The tier a score qualifies for, or null if it is not eligible for issuance. */
export function eligibleTier(score: number | null): ScoreTier | null {
  if (score == null) return null;      // not activated on mainnet -> not eligible
  if (score >= 750) return "min750";
  if (score >= 700) return "min700";
  if (score >= 650) return "min650";
  if (score >= ELIGIBILITY_FLOOR) return "min600";
  return null;                          // below the floor -> not eligible
}

/** The frozen CredentialType string for a tier. */
export function credentialType(tier: ScoreTier): string {
  return `${CRED_NAMESPACE}.${tier}`; // e.g. "io.xrplhub.score.v1.min750"
}

/** Thrown when a wallet's score does not qualify for a credential. */
export class ScoreNotEligibleError extends Error {
  readonly score: number | null;
  readonly floor = ELIGIBILITY_FLOOR;
  constructor(score: number | null) {
    super(
      score == null
        ? "Subject is not an activated account on XRPL mainnet — not eligible for a credential."
        : `Score ${score} is below the ${ELIGIBILITY_FLOOR} eligibility floor — no credential issued.`
    );
    this.name = "ScoreNotEligibleError";
    this.score = score;
  }
}

/** Accept an ascii type ("io.xrplhub.score.v1.min750") or a hex string; return upper hex. */
export function toCredentialTypeHex(input: string): string {
  const s = input.trim();
  const isHex = /^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0 && s.length >= 8;
  return (isHex ? s : convertStringToHex(s)).toUpperCase();
}

/** Default off-ledger pointer for a subject with no paid signed credential. */
export function defaultVerificationUri(subject: string): string {
  return `${PUBLIC_ORIGIN}/api/score/${subject}`;
}

// ── DEVNET CONNECTION GUARD ──────────────────────────────────────────────────

async function connectDevnetOrThrow(): Promise<Client> {
  const client = new Client(DEVNET_WSS);
  await client.connect();
  try {
    // Guard 1: the network id xrpl.js negotiated on connect.
    if (client.networkID !== DEVNET_NETWORK_ID) {
      throw new Error(
        `REFUSING: client.networkID=${String(client.networkID)}, expected Devnet (${DEVNET_NETWORK_ID}).`
      );
    }
    // Guard 2: independently re-check via server_info. Fail closed if absent.
    const info = await client.request({ command: "server_info" });
    const netId = (info.result as { info?: { network_id?: number } }).info?.network_id;
    if (netId !== DEVNET_NETWORK_ID) {
      throw new Error(
        `REFUSING: server_info network_id=${String(netId)}, expected Devnet (${DEVNET_NETWORK_ID}). No transaction submitted.`
      );
    }
    return client;
  } catch (err) {
    await client.disconnect().catch(() => {});
    throw err;
  }
}

// ── COST INTROSPECTION ──────────────────────────────────────────────────────

export interface DevnetCosts {
  networkId: number;
  baseReserveXRP: number;   // account reserve
  ownerReserveXRP: number;  // per owned object (a pending Credential counts as 1)
  baseFeeDrops: string;
}

export async function devnetCosts(): Promise<DevnetCosts> {
  const client = await connectDevnetOrThrow();
  try {
    const info = await client.request({ command: "server_info" });
    const vl = (info.result as {
      info: {
        network_id: number;
        validated_ledger?: { reserve_base_xrp?: number; reserve_inc_xrp?: number; base_fee_xrp?: number };
      };
    }).info;
    return {
      networkId: vl.network_id,
      baseReserveXRP: vl.validated_ledger?.reserve_base_xrp ?? NaN,
      ownerReserveXRP: vl.validated_ledger?.reserve_inc_xrp ?? NaN,
      baseFeeDrops: String(Math.round((vl.validated_ledger?.base_fee_xrp ?? 0.00001) * 1_000_000)),
    };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

// ── BUILD (pure) ────────────────────────────────────────────────────────────

export interface CredentialCreateParams {
  issuer: string;
  subject: string;
  credentialTypeHex: string;
  expirationRipple: number;
  uriHex: string;
}

/** Build the exact CredentialCreate txjson. No signing, no network. */
export function buildCredentialCreate(p: CredentialCreateParams): SubmittableTransaction {
  if (p.uriHex.length > MAX_URI_HEX) {
    throw new Error(`URI hex too long (${p.uriHex.length} > ${MAX_URI_HEX})`);
  }
  return {
    TransactionType: "CredentialCreate",
    Account: p.issuer,
    Subject: p.subject,
    CredentialType: p.credentialTypeHex,
    Expiration: p.expirationRipple,
    URI: p.uriHex,
  };
}

// ── ISSUE (Devnet) ──────────────────────────────────────────────────────────

export interface IssueResult {
  network: "devnet";
  txHash: string;
  validated: boolean;
  engineResult: string;
  ledgerIndex?: number;
  feeDrops?: string;
  issuer: string;
  subject: string;
  tier: ScoreTier;
  score: number;               // always >= ELIGIBILITY_FLOOR (ineligible throws)
  credentialType: string;      // ascii
  credentialTypeHex: string;
  expirationRipple: number;
  expirationISO: string;
  uri: string;
  uriHex: string;
}

/**
 * Score `subjectAddress` with the live 9-signal engine, map to a tier, and
 * issue a native CredentialCreate on DEVNET from DEVNET_CREDENTIAL_ISSUER_SEED.
 *
 * Only scores >= 600 are issued. Below the floor (or not on mainnet) throws
 * ScoreNotEligibleError BEFORE any connection or transaction — no Credential
 * Create, no reserve, no on-chain negative attestation.
 */
export async function issueScoreCredential(
  subjectAddress: string,
  opts: { verificationUri?: string } = {}
): Promise<IssueResult> {
  const seed = process.env.DEVNET_CREDENTIAL_ISSUER_SEED;
  if (!seed) throw new Error("DEVNET_CREDENTIAL_ISSUER_SEED is not set");
  const issuerWallet = Wallet.fromSeed(seed);

  // 1. Score (reads mainnet — the scoring source of truth).
  let score: number | null = null;
  try {
    const s = await scoreWallet(subjectAddress);
    score = s.ledgerScore;
  } catch (err) {
    if (!(err instanceof AccountNotFoundError)) throw err;
    score = null; // not on mainnet
  }

  // 2. Eligibility gate — fail before touching the network.
  const tier = eligibleTier(score);
  if (tier === null || score === null) throw new ScoreNotEligibleError(score);

  const typeAscii = credentialType(tier);
  const typeHex = convertStringToHex(typeAscii).toUpperCase();

  // 3. Expiration: 90 days out, Ripple-epoch seconds.
  const expUnixMs = Date.now() + VALIDITY_DAYS * 86_400_000;
  const expirationRipple = unixTimeToRippleTime(expUnixMs);

  // 4. URI: off-ledger pointer, hex.
  const uri = opts.verificationUri ?? defaultVerificationUri(subjectAddress);
  const uriHex = convertStringToHex(uri).toUpperCase();

  const tx = buildCredentialCreate({
    issuer: issuerWallet.classicAddress,
    subject: subjectAddress,
    credentialTypeHex: typeHex,
    expirationRipple,
    uriHex,
  });

  const client = await connectDevnetOrThrow();
  try {
    const prepared = await client.autofill(tx);
    const signed = issuerWallet.sign(prepared);
    const res = await client.submitAndWait(signed.tx_blob);
    const meta = res.result.meta;
    const engineResult =
      meta && typeof meta === "object" ? (meta as { TransactionResult: string }).TransactionResult : "unknown";
    return {
      network: "devnet",
      txHash: res.result.hash,
      validated: res.result.validated ?? false,
      engineResult,
      ledgerIndex: res.result.ledger_index,
      feeDrops: (prepared as { Fee?: string }).Fee,
      issuer: issuerWallet.classicAddress,
      subject: subjectAddress,
      tier,
      score,
      credentialType: typeAscii,
      credentialTypeHex: typeHex,
      expirationRipple,
      expirationISO: new Date(rippleTimeToUnixTime(expirationRipple)).toISOString(),
      uri,
      uriHex,
    };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

// ── ACCEPT (Devnet) — subject side, used by the PoC test ─────────────────────

export async function acceptCredential(p: {
  subjectSeed: string;
  issuer: string;
  credentialTypeHex: string;
}): Promise<{ txHash: string; engineResult: string; validated: boolean }> {
  const subjectWallet = Wallet.fromSeed(p.subjectSeed);
  const client = await connectDevnetOrThrow();
  try {
    const tx: SubmittableTransaction = {
      TransactionType: "CredentialAccept",
      Account: subjectWallet.classicAddress,
      Issuer: p.issuer,
      CredentialType: p.credentialTypeHex.toUpperCase(),
    };
    const prepared = await client.autofill(tx);
    const signed = subjectWallet.sign(prepared);
    const res = await client.submitAndWait(signed.tx_blob);
    const meta = res.result.meta;
    return {
      txHash: res.result.hash,
      engineResult:
        meta && typeof meta === "object" ? (meta as { TransactionResult: string }).TransactionResult : "unknown",
      validated: res.result.validated ?? false,
    };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

// ── VERIFY (Devnet, read-only) ──────────────────────────────────────────────

export interface CredentialStatus {
  found: boolean;
  accepted: boolean;
  expired: boolean;
  issuer: string;
  subject: string;
  credentialType: string;       // ascii if decodable
  credentialTypeHex: string;
  expirationRipple?: number;
  expirationISO?: string;
  uri?: string;
  uriDecoded?: string;
  ledgerIndex: number;          // the validated ledger the check ran against
  flags?: number;
  reason: string;
}

export async function readCredential(p: {
  issuer: string;
  subject: string;
  type: string; // ascii or hex
}): Promise<CredentialStatus> {
  const typeHex = toCredentialTypeHex(p.type);
  const client = await connectDevnetOrThrow();
  try {
    const led = await client.request({ command: "ledger", ledger_index: "validated" });
    const ledgerIndex = (led.result as { ledger_index: number }).ledger_index;
    const nowRipple = unixTimeToRippleTime(Date.now());

    let entry: Record<string, unknown> | null = null;
    try {
      // rippled's ledger_entry expects credential.credential_type (snake). Some
      // xrpl.js type versions name it credentialType — send snake, cast the req.
      const req = {
        command: "ledger_entry",
        ledger_index: "validated",
        credential: { subject: p.subject, issuer: p.issuer, credential_type: typeHex },
      } as unknown as LedgerEntryRequest;
      const res = await client.request(req);
      entry = ((res.result as unknown as { node?: Record<string, unknown> }).node) ?? null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/entryNotFound|not.*found/i.test(msg)) {
        return {
          found: false, accepted: false, expired: false,
          issuer: p.issuer, subject: p.subject,
          credentialType: safeDecode(typeHex), credentialTypeHex: typeHex,
          ledgerIndex, reason: "No such credential on the validated ledger.",
        };
      }
      throw err;
    }

    if (!entry) {
      return {
        found: false, accepted: false, expired: false,
        issuer: p.issuer, subject: p.subject,
        credentialType: safeDecode(typeHex), credentialTypeHex: typeHex,
        ledgerIndex, reason: "No such credential on the validated ledger.",
      };
    }

    const flags = Number(entry.Flags ?? 0);
    const accepted = (flags & 0x00010000) !== 0; // lsfAccepted
    const expRipple = entry.Expiration as number | undefined;
    const expired = expRipple != null && expRipple <= nowRipple;
    const uriHex = entry.URI as string | undefined;

    return {
      found: true,
      accepted,
      expired,
      issuer: String(entry.Issuer),
      subject: String(entry.Subject),
      credentialType: safeDecode(String(entry.CredentialType)),
      credentialTypeHex: String(entry.CredentialType),
      expirationRipple: expRipple,
      expirationISO: expRipple != null ? new Date(rippleTimeToUnixTime(expRipple)).toISOString() : undefined,
      uri: uriHex,
      uriDecoded: uriHex ? safeDecode(uriHex) : undefined,
      ledgerIndex,
      flags,
      reason: !accepted
        ? "Credential exists but the subject has not accepted it (reserve still on the issuer)."
        : expired
        ? "Credential was accepted but is past its Expiration."
        : "Credential exists, accepted, and current.",
    };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

function safeDecode(hex: string): string {
  try {
    return convertHexToString(hex);
  } catch {
    return hex;
  }
}

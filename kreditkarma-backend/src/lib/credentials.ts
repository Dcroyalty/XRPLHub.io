// src/lib/credentials.ts
// ─────────────────────────────────────────────────────────────────────────────
// XRPLScore as native XLS-70 Credentials — MAINNET.
//
// XLS-70 credentials carry no numeric value field, so XRPLScore ships as a
// TIERED credential. The CredentialType strings are frozen in
// docs/CREDENTIAL-SPEC.md:
//   io.xrplhub.score.v1.min600 / .min650 / .min700 / .min750
// A PermissionedDomain / lending vault gates on the (Issuer, CredentialType)
// pair. A wallet receives ONLY its highest qualifying tier (see the spec).
//
// ── SAFETY: this file can only ever touch XRPL MAINNET ────────────────────────
//  * The endpoint list is a hardcoded const — never an env var, never a param.
//  * Before ANY transaction is signed the connection is checked against
//    mainnet's network_id (0) via BOTH client.networkID and server_info. A
//    mismatch throws before signing. There is no code path to testnet/devnet.
//  * The issuer wallet derived from CREDENTIAL_ISSUER_SEED must match the
//    pinned EXPECTED_ISSUER address, or issuance throws before connecting.
//  * eligibleTier() refuses anything below 600 — no ledger object, no reserve,
//    no on-chain negative attestation, ever.
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
import { scoreWallet, AccountNotFoundError, METHODOLOGY } from "./xrplscore";

// ── HARD MAINNET LOCK ────────────────────────────────────────────────────────
export const MAINNET_NETWORK_ID = 0; // mainnet=0, testnet=1, devnet=2
export const MAINNET_ENDPOINTS = [
  "wss://xrplcluster.com",
  "wss://s1.ripple.com",
  "wss://s2.ripple.com",
] as const;

// The dedicated issuer wallet. NOT the treasury (rs59g3…QcLF). Pinned so a
// wrong seed / wrong wallet cannot issue under this identity.
export const EXPECTED_ISSUER = "rmWjCGeLtuLGerEuvHDkrsr46ej2Ni13f";

const VALIDITY_DAYS = 90;

// FROZEN — see docs/CREDENTIAL-SPEC.md. Do not change without a v2 namespace.
export const CRED_NAMESPACE = "io.xrplhub.score.v1";

const PUBLIC_ORIGIN = "https://www.xrplhub.io";
const MAX_URI_BYTES = 256; // XLS-70 URI limit

// Shown on every verification surface. Required — these are unsolicited,
// unaccepted, opinion-based ratings and that must be unmistakable.
export const UNSOLICITED_DISCLOSURE =
  "Unsolicited rating. This assessment was produced by XRPLHub from public XRP Ledger data. " +
  "The subject did not request it, has not accepted it, and no relationship or endorsement is implied. " +
  "Ratings are opinions based on on-chain activity, not financial advice.";

// ── TIERS ────────────────────────────────────────────────────────────────────
// Only POSITIVE tiers are ever issued. A failing score gets NO credential.
export type ScoreTier = "min750" | "min700" | "min650" | "min600";
export const ELIGIBILITY_FLOOR = 600;

/** The tier a score qualifies for, or null if it is not eligible for issuance. */
export function eligibleTier(score: number | null): ScoreTier | null {
  if (score == null) return null;         // not activated on mainnet
  if (score >= 750) return "min750";
  if (score >= 700) return "min700";
  if (score >= 650) return "min650";
  if (score >= ELIGIBILITY_FLOOR) return "min600";
  return null;                            // below the floor
}

/** The frozen CredentialType string for a tier. */
export function credentialType(tier: ScoreTier): string {
  return `${CRED_NAMESPACE}.${tier}`; // e.g. "io.xrplhub.score.v1.min750"
}

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

export class WrongNetworkError extends Error {}
export class WrongIssuerError extends Error {}

/** Accept an ascii type or an even-length hex string; return UPPER hex. */
export function toCredentialTypeHex(input: string): string {
  const s = input.trim();
  const isHex = /^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0 && s.length >= 8;
  return (isHex ? s : convertStringToHex(s)).toUpperCase();
}

/** The live verification page for a subject wallet. This URL IS the evidence. */
export function verificationUri(subject: string): string {
  return `${PUBLIC_ORIGIN}/verify/wallet/${subject}`;
}

// ── MAINNET CONNECTION GUARD ─────────────────────────────────────────────────

async function connectMainnetOrThrow(): Promise<Client> {
  let lastErr: unknown;
  for (const wss of MAINNET_ENDPOINTS) {
    const client = new Client(wss);
    try {
      await client.connect();

      // Guard 1: the network id xrpl.js negotiated on connect.
      if (client.networkID !== undefined && client.networkID !== MAINNET_NETWORK_ID) {
        throw new WrongNetworkError(
          `REFUSING: ${wss} client.networkID=${String(client.networkID)}, expected mainnet (0).`
        );
      }
      // Guard 2: independently re-check via server_info. Fail closed if absent.
      const info = await client.request({ command: "server_info" });
      const result = info.result as {
        info?: { network_id?: number; server_state?: string; validated_ledger?: { seq?: number } };
      };
      const netId = result.info?.network_id;
      if (netId !== MAINNET_NETWORK_ID) {
        throw new WrongNetworkError(
          `REFUSING: ${wss} server_info network_id=${String(netId)}, expected mainnet (0). No transaction submitted.`
        );
      }
      if (!result.info?.validated_ledger?.seq) {
        throw new WrongNetworkError(`REFUSING: ${wss} has no validated ledger — cannot trust it.`);
      }
      return client;
    } catch (err) {
      await client.disconnect().catch(() => {});
      if (err instanceof WrongNetworkError) throw err; // never fall through a network mismatch
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Could not reach an XRPL mainnet node.");
}

// ── LIVE MAINNET RESERVE / FEE INTROSPECTION ─────────────────────────────────

export interface MainnetCosts {
  networkId: number;
  buildVersion: string;
  baseReserveXRP: number;
  ownerReserveXRP: number;
  baseFeeDrops: string;
}

export async function mainnetCosts(): Promise<MainnetCosts> {
  const client = await connectMainnetOrThrow();
  try {
    const info = await client.request({ command: "server_info" });
    const i = (info.result as {
      info: {
        network_id: number;
        build_version: string;
        validated_ledger?: { reserve_base_xrp?: number; reserve_inc_xrp?: number; base_fee_xrp?: number };
      };
    }).info;
    const fee = await client.request({ command: "fee" });
    const baseFee = (fee.result as { drops?: { base_fee?: string } }).drops?.base_fee ?? "10";
    return {
      networkId: i.network_id,
      buildVersion: i.build_version,
      baseReserveXRP: i.validated_ledger?.reserve_base_xrp ?? NaN,
      ownerReserveXRP: i.validated_ledger?.reserve_inc_xrp ?? NaN,
      baseFeeDrops: baseFee,
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

export function buildCredentialCreate(p: CredentialCreateParams): SubmittableTransaction {
  const uriBytes = p.uriHex.length / 2;
  if (uriBytes > MAX_URI_BYTES) {
    throw new Error(`URI too long (${uriBytes} > ${MAX_URI_BYTES} bytes)`);
  }
  if (p.issuer === p.subject) {
    // A self-issued credential would auto-accept; that is a different product.
    throw new Error("issuer must not equal subject");
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

// ── ISSUE (mainnet) ─────────────────────────────────────────────────────────

export interface IssuePlan {
  issuer: string;
  subject: string;
  score: number;
  grade: string;
  tier: ScoreTier;
  credentialType: string;
  credentialTypeHex: string;
  expirationRipple: number;
  expirationISO: string;
  issuedAtISO: string;
  uri: string;
  uriHex: string;
  uriBytes: number;
  methodology: string;
  signals: Record<string, number>;
  txjson: SubmittableTransaction;
}

/**
 * Score `subject` with the live v1.1 engine, map to a tier, and produce the
 * exact CredentialCreate — but DO NOT sign or submit. For the approval step.
 * Throws ScoreNotEligibleError if the subject does not clear 600.
 */
export async function planScoreCredential(subject: string): Promise<IssuePlan> {
  let score: number | null = null;
  let grade = "";
  let signals: Record<string, number> = {};
  try {
    const s = await scoreWallet(subject);
    score = s.ledgerScore;
    grade = s.grade;
    signals = s.signals as Record<string, number>;
  } catch (err) {
    if (!(err instanceof AccountNotFoundError)) throw err;
    score = null;
  }

  const tier = eligibleTier(score);
  if (tier === null || score === null) throw new ScoreNotEligibleError(score);

  const typeAscii = credentialType(tier);
  const typeHex = convertStringToHex(typeAscii).toUpperCase();

  const nowMs = Date.now();
  const expMs = nowMs + VALIDITY_DAYS * 86_400_000;
  const expirationRipple = unixTimeToRippleTime(expMs);

  const uri = verificationUri(subject);
  const uriHex = convertStringToHex(uri).toUpperCase();

  const txjson = buildCredentialCreate({
    issuer: EXPECTED_ISSUER,
    subject,
    credentialTypeHex: typeHex,
    expirationRipple,
    uriHex,
  });

  return {
    issuer: EXPECTED_ISSUER,
    subject,
    score,
    grade,
    tier,
    credentialType: typeAscii,
    credentialTypeHex: typeHex,
    expirationRipple,
    expirationISO: new Date(rippleTimeToUnixTime(expirationRipple)).toISOString(),
    issuedAtISO: new Date(nowMs).toISOString(),
    uri,
    uriHex,
    uriBytes: uriHex.length / 2,
    methodology: METHODOLOGY,
    signals,
    txjson,
  };
}

export interface IssueResult {
  network: "mainnet";
  txHash: string;
  validated: boolean;
  engineResult: string;
  ledgerIndex?: number;
  feeDrops?: string;
  plan: IssuePlan;
}

/**
 * Re-score, re-gate, and issue on mainnet from CREDENTIAL_ISSUER_SEED.
 *
 * `plan` (from planScoreCredential) is the APPROVED plan. Before submitting,
 * this re-scores the subject and refuses if the tier changed — the attestation
 * must be true at the moment of issuance.
 */
export async function issueScoreCredential(plan: IssuePlan): Promise<IssueResult> {
  const seed = process.env.CREDENTIAL_ISSUER_SEED;
  if (!seed) throw new Error("CREDENTIAL_ISSUER_SEED is not set");
  const wallet = Wallet.fromSeed(seed);
  if (wallet.classicAddress !== EXPECTED_ISSUER) {
    throw new WrongIssuerError(
      `REFUSING: CREDENTIAL_ISSUER_SEED derives ${wallet.classicAddress}, expected ${EXPECTED_ISSUER}.`
    );
  }
  if (plan.issuer !== EXPECTED_ISSUER) {
    throw new WrongIssuerError(`REFUSING: plan issuer ${plan.issuer} != ${EXPECTED_ISSUER}.`);
  }

  // Re-score at issuance time. The tier must still hold.
  const fresh = await planScoreCredential(plan.subject);
  if (fresh.tier !== plan.tier) {
    throw new ScoreNotEligibleError(fresh.score);
  }

  const client = await connectMainnetOrThrow();
  try {
    const prepared = await client.autofill(plan.txjson);
    const signed = wallet.sign(prepared);
    const res = await client.submitAndWait(signed.tx_blob);
    const meta = res.result.meta;
    const engineResult =
      meta && typeof meta === "object"
        ? (meta as { TransactionResult: string }).TransactionResult
        : "unknown";
    return {
      network: "mainnet",
      txHash: res.result.hash,
      validated: res.result.validated ?? false,
      engineResult,
      ledgerIndex: res.result.ledger_index,
      feeDrops: (prepared as { Fee?: string }).Fee,
      plan,
    };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

// ── READ / VERIFY (mainnet, read-only) ──────────────────────────────────────

export interface CredentialStatus {
  found: boolean;
  accepted: boolean;
  expired: boolean;
  issuer: string;
  subject: string;
  credentialType: string;
  credentialTypeHex: string;
  expirationRipple?: number;
  expirationISO?: string;
  issuedApproxISO?: string; // Expiration - 90d
  uri?: string;
  uriDecoded?: string;
  ledgerIndex: number;
  flags?: number;
  reason: string;
}

export async function readCredential(p: {
  issuer: string;
  subject: string;
  type: string; // ascii or hex
}): Promise<CredentialStatus> {
  const typeHex = toCredentialTypeHex(p.type);
  const client = await connectMainnetOrThrow();
  try {
    const led = await client.request({ command: "ledger", ledger_index: "validated" });
    const ledgerIndex = (led.result as { ledger_index: number }).ledger_index;
    const nowRipple = unixTimeToRippleTime(Date.now());

    const notFound = (): CredentialStatus => ({
      found: false, accepted: false, expired: false,
      issuer: p.issuer, subject: p.subject,
      credentialType: safeDecode(typeHex), credentialTypeHex: typeHex,
      ledgerIndex, reason: "No such credential on the validated ledger.",
    });

    let entry: Record<string, unknown> | null = null;
    try {
      const req = {
        command: "ledger_entry",
        ledger_index: "validated",
        credential: { subject: p.subject, issuer: p.issuer, credential_type: typeHex },
      } as unknown as LedgerEntryRequest;
      const res = await client.request(req);
      entry = (res.result as unknown as { node?: Record<string, unknown> }).node ?? null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/entryNotFound|not.*found/i.test(msg)) return notFound();
      throw err;
    }
    if (!entry) return notFound();

    const flags = Number(entry.Flags ?? 0);
    const accepted = (flags & 0x00010000) !== 0; // lsfAccepted
    const expRipple = entry.Expiration as number | undefined;
    const expired = expRipple != null && expRipple <= nowRipple;
    const uriHex = entry.URI as string | undefined;
    const expMs = expRipple != null ? rippleTimeToUnixTime(expRipple) : undefined;

    return {
      found: true,
      accepted,
      expired,
      issuer: String(entry.Issuer),
      subject: String(entry.Subject),
      credentialType: safeDecode(String(entry.CredentialType)),
      credentialTypeHex: String(entry.CredentialType),
      expirationRipple: expRipple,
      expirationISO: expMs != null ? new Date(expMs).toISOString() : undefined,
      issuedApproxISO: expMs != null ? new Date(expMs - VALIDITY_DAYS * 86_400_000).toISOString() : undefined,
      uri: uriHex,
      uriDecoded: uriHex ? safeDecode(uriHex) : undefined,
      ledgerIndex,
      flags,
      reason: !accepted
        ? "Credential exists on-ledger. Subject has not run CredentialAccept, so it is not yet usable for permissioned gating (the 0.2 XRP reserve is still on the issuer)."
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

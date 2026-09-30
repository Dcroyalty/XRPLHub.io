// src/lib/domainCredential.ts
// The io.xrplhub.domain.v1.verified credential: an XLS-70 attestation that, at issuance, an account's own ledger
// `Domain` field AND that domain's xrp-ledger.toml (via the REAL two-way check — src/lib/domainVerify.ts, item 0 of
// this build) confirmed the link. A portable, on-ledger version of the checkmark this same check already powers on
// the MPT issuer risk page.
//
// Opt-in only, free to request (no purchase gate) — this is a low-friction ecosystem trust signal, not a paid
// product. See POST /api/credentials/domain-request.
//
// 90-day expiry, matching the score/MPT-declared families for integrator consistency. A domain-hijack or
// DNS-reassignment window of up to 90 days is a real, if small, exposure — flagged, not solved, here.

import type { PrismaClient } from "@prisma/client";
import { Wallet, convertStringToHex, unixTimeToRippleTime, rippleTimeToUnixTime, type SubmittableTransaction } from "xrpl";
import { EXPECTED_ISSUER, buildCredentialCreate, connectMainnetOrThrow, WrongIssuerError, type IssueResult } from "./credentials";
import { verifyDomainTwoWay, type TomlAccountsCheck } from "./domainVerify";
import { xrplRpc } from "./xrplNodes";
import { deleteExpiredCredentialIfAny } from "./credentialOps";

export const DOMAIN_CRED_NAMESPACE = "io.xrplhub.domain.v1";
export const DOMAIN_VERIFIED_TYPE = "io.xrplhub.domain.v1.verified";
export const DOMAIN_VERIFIED_TYPE_HEX = convertStringToHex(DOMAIN_VERIFIED_TYPE).toUpperCase();
export const DOMAIN_CRED_VALIDITY_DAYS = 90;
const PUBLIC_ORIGIN = "https://www.xrplhub.io";

/** The live verification page for a subject's domain link. This URL IS the evidence. */
export function domainVerificationUri(subject: string): string {
  return `${PUBLIC_ORIGIN}/verify/domain/${subject}`;
}

export const DOMAIN_CRED_STATEMENT_NOTE =
  "This credential attests that, at issuance, this account's own ledger Domain field and that domain's xrp-ledger.toml confirmed a " +
  "two-way link (the domain lists this exact account under [[ACCOUNTS]]). It is a domain-control check, not identity verification, " +
  "not KYC, and not a statement about the account's trustworthiness, intentions, or the content of that domain.";

export interface DomainCredPlan {
  issuer: typeof EXPECTED_ISSUER;
  subject: string;
  credentialType: typeof DOMAIN_VERIFIED_TYPE;
  credentialTypeHex: string;
  expirationRipple: number;
  expirationISO: string;
  uri: string;
  uriHex: string;
  txjson: SubmittableTransaction;
}

/** Build (never sign) the CredentialCreate for one subject. Pure — does not check the domain link itself. */
export function planDomainCredential(subject: string): DomainCredPlan {
  const expirationRipple = unixTimeToRippleTime(Date.now() + DOMAIN_CRED_VALIDITY_DAYS * 86_400_000);
  const uri = domainVerificationUri(subject);
  const uriHex = convertStringToHex(uri).toUpperCase();
  const txjson = buildCredentialCreate({ issuer: EXPECTED_ISSUER, subject, credentialTypeHex: DOMAIN_VERIFIED_TYPE_HEX, expirationRipple, uriHex });
  return {
    issuer: EXPECTED_ISSUER,
    subject,
    credentialType: DOMAIN_VERIFIED_TYPE,
    credentialTypeHex: DOMAIN_VERIFIED_TYPE_HEX,
    expirationRipple,
    expirationISO: new Date(rippleTimeToUnixTime(expirationRipple)).toISOString(),
    uri,
    uriHex,
    txjson,
  };
}

function safeDecodeHex(hex: string): string | null {
  try {
    return Buffer.from(hex, "hex").toString("utf8");
  } catch {
    return null;
  }
}

export class NoDomainDeclaredError extends Error {
  constructor(subject: string) {
    super(`${subject} has no Domain field set on the validated ledger — nothing to verify.`);
    this.name = "NoDomainDeclaredError";
  }
}
export class DomainNotVerifiedError extends Error {
  readonly domain: string;
  readonly check: TomlAccountsCheck;
  constructor(domain: string, check: TomlAccountsCheck) {
    super(check.reason);
    this.name = "DomainNotVerifiedError";
    this.domain = domain;
    this.check = check;
  }
}
export class LedgerUnavailableError extends Error {
  constructor() {
    super("Could not read this account from the XRP Ledger right now.");
    this.name = "LedgerUnavailableError";
  }
}

/** The account's own ledger Domain field (hex-decoded), or null if unset. Live read, validated ledger. */
export async function currentDeclaredDomain(address: string): Promise<string | null> {
  const r = await xrplRpc("account_info", { account: address, ledger_index: "validated" });
  if (!r.ok) throw new LedgerUnavailableError();
  const acct = (r.body as { result?: { account_data?: { Domain?: string }; error?: string } }).result;
  if (!acct?.account_data) {
    if (acct?.error === "actNotFound") throw new NoDomainDeclaredError(address); // not activated: nothing to verify either way
    throw new LedgerUnavailableError();
  }
  const hex = acct.account_data.Domain;
  return hex ? safeDecodeHex(hex) : null;
}

/**
 * Run the real, live, two-way check for `subject` right now: read its own Domain field, then confirm that domain's
 * xrp-ledger.toml lists it under [[ACCOUNTS]] (src/lib/domainVerify.ts). Throws NoDomainDeclaredError /
 * DomainNotVerifiedError / LedgerUnavailableError — never returns a false "verified".
 */
export async function verifySubjectDomainNow(subject: string): Promise<{ domain: string; check: TomlAccountsCheck }> {
  const domain = await currentDeclaredDomain(subject);
  if (!domain) throw new NoDomainDeclaredError(subject);
  const check = await verifyDomainTwoWay(domain, subject);
  if (!check.ok) throw new DomainNotVerifiedError(domain, check);
  return { domain, check };
}

/**
 * Verify `subject`'s domain link FRESH, right now. Throws on any failure (see verifySubjectDomainNow) — nothing is
 * ever queued for an account that doesn't currently pass. On success, queues a CredentialRequest (kind
 * "domain-verified") unless one is already open, in which case that existing row is returned instead of a duplicate.
 */
export async function requestDomainCredential(
  prisma: PrismaClient,
  subject: string
): Promise<{ queued: boolean; requestId: string; domain: string; reused: boolean }> {
  const { domain } = await verifySubjectDomainNow(subject);

  const open = await prisma.credentialRequest.findFirst({ where: { subject, kind: "domain-verified", status: "queued" }, orderBy: { requestedAt: "desc" } });
  if (open) return { queued: true, requestId: open.id, domain, reused: true };

  const row = await prisma.credentialRequest.create({
    data: { kind: "domain-verified", subject, tier: "verified", credentialType: DOMAIN_VERIFIED_TYPE, subjectRef: domain, status: "queued" },
  });
  return { queued: true, requestId: row.id, domain, reused: false };
}

/**
 * Sign + submit on mainnet from CREDENTIAL_ISSUER_SEED. The domain link can change (DNS reassigned,
 * toml edited, Domain field cleared) between when a request was queued and issuance -- ALWAYS re-checks
 * both directions immediately before signing via verifySubjectDomainNow, which throws on any failure.
 */
export async function issueDomainCredential(plan: DomainCredPlan): Promise<IssueResult> {
  const seed = process.env.CREDENTIAL_ISSUER_SEED;
  if (!seed) throw new Error("CREDENTIAL_ISSUER_SEED is not set");
  const wallet = Wallet.fromSeed(seed);
  if (wallet.classicAddress !== EXPECTED_ISSUER) {
    throw new WrongIssuerError(`REFUSING: CREDENTIAL_ISSUER_SEED derives ${wallet.classicAddress}, expected ${EXPECTED_ISSUER}.`);
  }
  if (plan.issuer !== EXPECTED_ISSUER) {
    throw new WrongIssuerError(`REFUSING: plan issuer ${plan.issuer} != ${EXPECTED_ISSUER}.`);
  }

  // Re-verify both directions right now. Throws (NoDomainDeclaredError / DomainNotVerifiedError /
  // LedgerUnavailableError) if it no longer holds -- never signs on a stale verification.
  await verifySubjectDomainNow(plan.subject);

  const client = await connectMainnetOrThrow();
  try {
    await deleteExpiredCredentialIfAny(client, wallet, EXPECTED_ISSUER, plan.subject, plan.credentialTypeHex);

    const prepared = await client.autofill(plan.txjson);
    const signed = wallet.sign(prepared);
    const res = await client.submitAndWait(signed.tx_blob);
    const meta = res.result.meta;
    const engineResult = meta && typeof meta === "object" ? (meta as { TransactionResult: string }).TransactionResult : "unknown";
    return {
      network: "mainnet",
      txHash: res.result.hash,
      validated: res.result.validated ?? false,
      engineResult,
      ledgerIndex: res.result.ledger_index,
      feeDrops: (prepared as { Fee?: string }).Fee,
      plan: plan as unknown as IssueResult["plan"],
    };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

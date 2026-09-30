// src/lib/screenCredential.ts
// The io.xrplhub.screen.v2.nomatch credential: an XLS-70 attestation that, at a stated time, an XRP Ledger address
// did NOT appear on the current snapshot of every sanctions list XRPLHub screens (OFAC-SDN, EU-FSF, UK-SL).
//
// HARD LINE (matches every screening receipt — src/lib/screen.ts SCREEN_DISCLAIMER_SHORT): this attests to a
// PROCESS, never a conclusion. "No match" is not a statement that the address, or anyone associated with it, is
// clean, safe, lawful, or unsanctioned. The credential type is deliberately named "nomatch", never "clean" or
// "screened-ok" or anything that reads as a verdict.
//
// OPT-IN ONLY — unlike the score credential, this is never issued unsolicited: only a subject (or whoever screens it
// through the request endpoint) who explicitly asks gets one, and only after a FRESH screen finds no match. See
// POST /api/credentials/screen-request.
//
// Scope: screening covers XRPL, EVM, Bitcoin and Tron addresses, but a Credential's Subject must be an XRP Ledger
// account (XLS-70 is XRPL-only) — so this credential can only ever be issued for an XRPL address, even though the
// underlying screen could run on any of the four chains.
//
// 30-DAY EXPIRY (shorter than the 90-day score/MPT credentials, deliberately): sanctions lists change; a wallet
// screened clean today can be listed tomorrow, and re-issuing every 30 days is the correction window, not a
// convenience. This is the credential family the brief calls out as costing real, recurring operator effort — every
// live holder needs a fresh screen and a fresh CredentialCreate roughly every 30 days if they want to stay covered.

import type { PrismaClient } from "@prisma/client";
import { Wallet, convertStringToHex, unixTimeToRippleTime, rippleTimeToUnixTime, type SubmittableTransaction } from "xrpl";
import { EXPECTED_ISSUER, buildCredentialCreate, connectMainnetOrThrow, WrongIssuerError, type IssueResult } from "./credentials";
import { screenAll, type ScreenOutcome } from "./screen";
import { deleteExpiredCredentialIfAny } from "./credentialOps";

export const SCREEN_CRED_NAMESPACE = "io.xrplhub.screen.v2";
export const SCREEN_NOMATCH_TYPE = "io.xrplhub.screen.v2.nomatch";
export const SCREEN_NOMATCH_TYPE_HEX = convertStringToHex(SCREEN_NOMATCH_TYPE).toUpperCase();
export const SCREEN_CRED_VALIDITY_DAYS = 30;
const PUBLIC_ORIGIN = "https://www.xrplhub.io";

/** The live verification page for a subject's screening status. This URL IS the evidence. */
export function screenVerificationUri(subject: string): string {
  return `${PUBLIC_ORIGIN}/verify/screening/${subject}`;
}

export const SCREEN_CRED_STATEMENT_NOTE =
  "This credential attests to a process, not ground truth: it records that, at issuance, the named address did not appear on the " +
  "current snapshot of every list XRPLHub screens. It is not a statement that the address, or anyone associated with it, is clean, " +
  "safe, lawful, or unsanctioned, and it is not legal, compliance, or risk advice.";

export interface ScreenCredPlan {
  issuer: typeof EXPECTED_ISSUER;
  subject: string;
  credentialType: typeof SCREEN_NOMATCH_TYPE;
  credentialTypeHex: string;
  expirationRipple: number;
  expirationISO: string;
  uri: string;
  uriHex: string;
  txjson: SubmittableTransaction;
}

/** Build (never sign) the CredentialCreate for one subject. Pure — does not check whether the subject is actually clear. */
export function planScreenCredential(subject: string): ScreenCredPlan {
  const expirationRipple = unixTimeToRippleTime(Date.now() + SCREEN_CRED_VALIDITY_DAYS * 86_400_000);
  const uri = screenVerificationUri(subject);
  const uriHex = convertStringToHex(uri).toUpperCase();
  const txjson = buildCredentialCreate({
    issuer: EXPECTED_ISSUER,
    subject,
    credentialTypeHex: SCREEN_NOMATCH_TYPE_HEX,
    expirationRipple,
    uriHex,
  });
  return {
    issuer: EXPECTED_ISSUER,
    subject,
    credentialType: SCREEN_NOMATCH_TYPE,
    credentialTypeHex: SCREEN_NOMATCH_TYPE_HEX,
    expirationRipple,
    expirationISO: new Date(rippleTimeToUnixTime(expirationRipple)).toISOString(),
    uri,
    uriHex,
    txjson,
  };
}

export class ScreenCredListedError extends Error {
  readonly outcome: ScreenOutcome;
  constructor(outcome: ScreenOutcome) {
    super("This address appears on a current list snapshot — no credential can be requested for it.");
    this.name = "ScreenCredListedError";
    this.outcome = outcome;
  }
}

/**
 * Screen `subject` FRESH, right now, against every list. Throws ScreenCredListedError if it is listed (no request is
 * ever queued for a listed address). On a clean result, queues a CredentialRequest (kind "screen-nomatch") unless one
 * is already open for this subject — in which case that existing row is returned instead of a duplicate.
 */
export async function requestScreenCredential(
  prisma: PrismaClient,
  subject: string
): Promise<{ queued: boolean; requestId: string; outcome: ScreenOutcome; reused: boolean }> {
  const outcome = await screenAll(prisma, subject, "credential-request", {});
  if (outcome.leaf.result.listed) throw new ScreenCredListedError(outcome);

  const open = await prisma.credentialRequest.findFirst({ where: { subject, kind: "screen-nomatch", status: "queued" }, orderBy: { requestedAt: "desc" } });
  if (open) return { queued: true, requestId: open.id, outcome, reused: true };

  const row = await prisma.credentialRequest.create({
    data: { kind: "screen-nomatch", subject, tier: "nomatch", credentialType: SCREEN_NOMATCH_TYPE, subjectRef: outcome.queryId, status: "queued" },
  });
  return { queued: true, requestId: row.id, outcome, reused: false };
}

/**
 * Sign + submit on mainnet from CREDENTIAL_ISSUER_SEED. UNLIKE mpt-declared, the fact this attests DOES
 * change day to day (lists update) -- ALWAYS re-screens immediately before signing and refuses if the
 * address is listed at that moment. The request's original screen (possibly hours or days old) is never
 * trusted for the actual issuance decision.
 */
export async function issueScreenCredential(prisma: PrismaClient, plan: ScreenCredPlan): Promise<IssueResult> {
  const seed = process.env.CREDENTIAL_ISSUER_SEED;
  if (!seed) throw new Error("CREDENTIAL_ISSUER_SEED is not set");
  const wallet = Wallet.fromSeed(seed);
  if (wallet.classicAddress !== EXPECTED_ISSUER) {
    throw new WrongIssuerError(`REFUSING: CREDENTIAL_ISSUER_SEED derives ${wallet.classicAddress}, expected ${EXPECTED_ISSUER}.`);
  }
  if (plan.issuer !== EXPECTED_ISSUER) {
    throw new WrongIssuerError(`REFUSING: plan issuer ${plan.issuer} != ${EXPECTED_ISSUER}.`);
  }

  // Re-screen at issuance time. Refuse outright if listed NOW, regardless of what the queued request found.
  const fresh = await screenAll(prisma, plan.subject, "operator:issue-screen-credential", {});
  if (fresh.leaf.result.listed) throw new ScreenCredListedError(fresh);

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

// src/lib/mptCredential.ts
// The io.xrplhub.mpt.v1.declared credential: an XLS-70 attestation that a backing declaration and the issuer flags
// of at least one MPT issuance were RECORDED on-ledger through XRPLHub at issuance time.
//
// HARD LINE — read src/lib/mptBacking.ts before touching this file: "XRPLHub publishes what the issuer declared. We
// do not verify it, we cannot verify it, and a declaration is not evidence." This credential is named "declared",
// never "reviewed" or "verified", and its statement never claims the declaration is true. It also does not claim
// every MPT this account has issued carries a declaration — only that at least one did, at the stated time (an
// issuer can mint further MPTs later with a different, or no, declaration; this credential does not track that).
//
// Trigger: automatic, right after a successful `mptissue` purchase (src/app/api/execute/verify/route.ts) — the
// issuer already engaged us by buying the service, so this is queued without a separate opt-in request, exactly like
// the "we issue, they accept" score-credential flow. A pending credential is never usable until CredentialAccept.

import type { PrismaClient } from "@prisma/client";
import { convertStringToHex, unixTimeToRippleTime, rippleTimeToUnixTime, type SubmittableTransaction } from "xrpl";
import { EXPECTED_ISSUER, buildCredentialCreate } from "./credentials";

export const MPT_CRED_NAMESPACE = "io.xrplhub.mpt.v1";
export const MPT_DECLARED_TYPE = "io.xrplhub.mpt.v1.declared";
export const MPT_DECLARED_TYPE_HEX = convertStringToHex(MPT_DECLARED_TYPE).toUpperCase();
export const MPT_CRED_VALIDITY_DAYS = 90;
const PUBLIC_ORIGIN = "https://www.xrplhub.io";

/** The live verification page for an issuer's declared MPTs. This URL IS the evidence. */
export function mptDeclaredVerificationUri(issuer: string): string {
  return `${PUBLIC_ORIGIN}/verify/mpt-issuer/${issuer}`;
}

export interface MptDeclaredPlan {
  issuer: typeof EXPECTED_ISSUER;
  subject: string;
  credentialType: typeof MPT_DECLARED_TYPE;
  credentialTypeHex: string;
  expirationRipple: number;
  expirationISO: string;
  uri: string;
  uriHex: string;
  txjson: SubmittableTransaction;
}

/** Build (never sign) the CredentialCreate for one issuer. Pure. */
export function planMptDeclaredCredential(issuerSubject: string): MptDeclaredPlan {
  const expirationRipple = unixTimeToRippleTime(Date.now() + MPT_CRED_VALIDITY_DAYS * 86_400_000);
  const uri = mptDeclaredVerificationUri(issuerSubject);
  const uriHex = convertStringToHex(uri).toUpperCase();
  const txjson = buildCredentialCreate({
    issuer: EXPECTED_ISSUER,
    subject: issuerSubject,
    credentialTypeHex: MPT_DECLARED_TYPE_HEX,
    expirationRipple,
    uriHex,
  });
  return {
    issuer: EXPECTED_ISSUER,
    subject: issuerSubject,
    credentialType: MPT_DECLARED_TYPE,
    credentialTypeHex: MPT_DECLARED_TYPE_HEX,
    expirationRipple,
    expirationISO: new Date(rippleTimeToUnixTime(expirationRipple)).toISOString(),
    uri,
    uriHex,
    txjson,
  };
}

/**
 * Queue an io.xrplhub.mpt.v1.declared request for `issuer`, right after their mptissue purchase for `issuanceId`
 * delivered. Best-effort and idempotent: skipped (not an error) if `issuer` already has one queued, or is not a
 * valid subject (issuer === our own credential issuer — cannot happen in practice, guarded anyway).
 */
export async function queueMptDeclaredCredential(prisma: PrismaClient, issuer: string, issuanceId: string | null): Promise<{ queued: boolean; reason: string }> {
  if (issuer === EXPECTED_ISSUER) return { queued: false, reason: "issuer must not equal the credential issuer" };
  const open = await prisma.credentialRequest.findFirst({ where: { subject: issuer, kind: "mpt-declared", status: "queued" } });
  if (open) return { queued: false, reason: "already queued" };
  await prisma.credentialRequest.create({
    data: {
      kind: "mpt-declared",
      subject: issuer,
      tier: "declared",
      credentialType: MPT_DECLARED_TYPE,
      subjectRef: issuanceId,
      status: "queued",
    },
  });
  return { queued: true, reason: "queued" };
}

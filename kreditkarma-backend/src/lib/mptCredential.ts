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
import { Wallet, convertStringToHex, unixTimeToRippleTime, rippleTimeToUnixTime, type SubmittableTransaction } from "xrpl";
import { EXPECTED_ISSUER, buildCredentialCreate, connectMainnetOrThrow, WrongIssuerError, type IssueResult } from "./credentials";
import { deleteExpiredCredentialIfAny } from "./credentialOps";

export const MPT_CRED_NAMESPACE = "io.xrplhub.mpt.v1";
export const MPT_DECLARED_TYPE = "io.xrplhub.mpt.v1.declared";
export const MPT_DECLARED_TYPE_HEX = convertStringToHex(MPT_DECLARED_TYPE).toUpperCase();
// 1 year — longer than the score/domain families (90d) and much longer than screening (30d), because what this
// attests ("a declaration was recorded at issuance") is inherently a point-in-time fact: it doesn't go stale the way
// a score or a sanctions check does. It can still be OUTDATED by a later MPT from the same issuer with a different
// declaration, or by DynamicMPT (XLS-94) letting the issuer rewrite an existing one's metadata — but expiry doesn't
// fix that either way, so there's no correctness reason to check in more often than once a year.
export const MPT_CRED_VALIDITY_DAYS = 365;
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

/**
 * Sign + submit on mainnet from CREDENTIAL_ISSUER_SEED. Unlike the score credential, no re-check is
 * needed before issuing: the fact attested ("a declaration was recorded at issuance time") does not
 * change after the fact. It was already true the moment mptissue delivered.
 */
export async function issueMptDeclaredCredential(plan: MptDeclaredPlan): Promise<IssueResult> {
  const seed = process.env.CREDENTIAL_ISSUER_SEED;
  if (!seed) throw new Error("CREDENTIAL_ISSUER_SEED is not set");
  const wallet = Wallet.fromSeed(seed);
  if (wallet.classicAddress !== EXPECTED_ISSUER) {
    throw new WrongIssuerError(`REFUSING: CREDENTIAL_ISSUER_SEED derives ${wallet.classicAddress}, expected ${EXPECTED_ISSUER}.`);
  }
  if (plan.issuer !== EXPECTED_ISSUER) {
    throw new WrongIssuerError(`REFUSING: plan issuer ${plan.issuer} != ${EXPECTED_ISSUER}.`);
  }

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
      // IssueResult.plan is typed for the score credential's IssuePlan; this family's plan shape
      // differs (no score/tier/methodology). Cast is safe -- callers of THIS function only ever read
      // the fields MptDeclaredPlan actually has.
      plan: plan as unknown as IssueResult["plan"],
    };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

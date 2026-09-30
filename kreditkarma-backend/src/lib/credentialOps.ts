// src/lib/credentialOps.ts
// TS port of scripts/credentialOps.cjs, for the automatic-issuance path (credentialAutoIssue.ts) --
// the hand-run CLI scripts keep using the .cjs version; this is the exact same logic so the two paths
// can never silently drift apart on the one thing that matters most here: never double-issuing.
//
// WHY THIS EXISTS: CredentialCreate fails with tecDUPLICATE if a Credential object already exists for
// the same (Issuer, Subject, CredentialType) triple -- EXPIRY DOES NOT MATTER to that check (confirmed
// against xrpl.org's CredentialCreate reference: "A credential with the same subject, issuer, and
// credential type already exists in the ledger" -- presence-based, not validity-based). So reissuing to
// a subject who already held one (even a long-expired one) is NOT a fresh CredentialCreate -- it fails
// outright unless the old object is deleted first. There is also no protocol-level auto-cleanup of
// expired credentials: they sit on the ledger, on whichever side's reserve they were on, until someone
// submits CredentialDelete.

import type { Client, Wallet } from "xrpl";
import { unixTimeToRippleTime } from "xrpl";

export interface CredentialLedgerNode {
  Issuer: string;
  Subject: string;
  CredentialType: string;
  Expiration?: number;
  Flags?: number;
  URI?: string;
  index: string;
}

/** The Credential ledger object for (issuer, subject, typeHex), or null if none exists. */
export async function existingCredential(client: Client, issuer: string, subject: string, typeHex: string): Promise<CredentialLedgerNode | null> {
  try {
    const r = await client.request({
      command: "ledger_entry",
      ledger_index: "validated",
      // @ts-expect-error -- xrpl.js's ledger_entry request typing hasn't caught up with the credential param (XLS-70)
      credential: { subject, issuer, credential_type: typeHex },
    });
    return (r.result as unknown as { node: CredentialLedgerNode }).node;
  } catch (e) {
    if (/entryNotFound|not.*found/i.test(String(e instanceof Error ? e.message : e))) return null;
    throw e;
  }
}

/** True if `node.Expiration` (Ripple time) is in the past. A credential with no Expiration field never expires. */
export function isExpired(node: CredentialLedgerNode, nowRippleSeconds: number): boolean {
  return typeof node.Expiration === "number" && node.Expiration <= nowRippleSeconds;
}

export interface DeleteExpiredResult {
  deleted: boolean;
  wasAccepted?: boolean;
  txHash?: string;
}

/**
 * If a credential already exists for (issuer, subject, typeHex):
 *   - not expired -> throws (refuse to touch a live credential; the caller should not have reached this)
 *   - expired     -> submits CredentialDelete from `wallet` (the issuer), waits for validation, returns
 *                    { deleted: true, wasAccepted, txHash }
 * If none exists, returns { deleted: false }.
 */
export async function deleteExpiredCredentialIfAny(client: Client, wallet: Wallet, issuer: string, subject: string, typeHex: string): Promise<DeleteExpiredResult> {
  const nowRipple = unixTimeToRippleTime(Date.now());
  const existing = await existingCredential(client, issuer, subject, typeHex);
  if (!existing) return { deleted: false };
  if (!isExpired(existing, nowRipple)) {
    const exp = existing.Expiration ? new Date((existing.Expiration + 946_684_800) * 1000).toISOString() : "never";
    throw new Error(`A credential already exists for this subject and has not expired (expires ${exp}) — refusing to duplicate or delete a live credential.`);
  }
  const wasAccepted = (Number(existing.Flags || 0) & 0x00010000) !== 0; // lsfAccepted
  const tx = { TransactionType: "CredentialDelete" as const, Account: wallet.classicAddress, Issuer: issuer, Subject: subject, CredentialType: typeHex };
  const prepared = await client.autofill(tx);
  const signed = wallet.sign(prepared);
  const res = await client.submitAndWait(signed.tx_blob);
  const meta = res.result.meta;
  const result = meta && typeof meta === "object" ? (meta as { TransactionResult: string }).TransactionResult : "unknown";
  if (result !== "tesSUCCESS") throw new Error(`CredentialDelete of the expired credential failed: ${result}`);
  return { deleted: true, wasAccepted, txHash: res.result.hash };
}

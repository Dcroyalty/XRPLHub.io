/* scripts/credentialOps.cjs
 *
 * Shared by every issue-*-credential script (score, mpt-declared, screen-nomatch, domain-verified): the ledger-level
 * mechanics of reissuing a credential safely.
 *
 * WHY THIS EXISTS: CredentialCreate fails with tecDUPLICATE if a Credential object already exists for the same
 * (Issuer, Subject, CredentialType) triple — EXPIRY DOES NOT MATTER to that check (confirmed against xrpl.org's
 * CredentialCreate reference, 2026-09-28: "A credential with the same subject, issuer, and credential type already
 * exists in the ledger" — presence-based, not validity-based). So reissuing to a subject who already held one (even
 * a long-expired one) is NOT a fresh CredentialCreate — it fails outright unless the old object is deleted first.
 * There is also no protocol-level auto-cleanup of expired credentials (confirmed against CredentialDelete's
 * reference): they sit on the ledger, and on whichever side's reserve they were on, until someone submits
 * CredentialDelete. The issuer can always delete its own credentials; once expired, anyone can.
 *
 * `existingCredential` + `deleteExpiredCredentialIfAny` let every issuance script reissue correctly: if a credential
 * already exists and has expired, delete it first (this also returns whichever side's reserve it was tying up —
 * the issuer's if it was never accepted, the subject's if it was); if it exists and has NOT expired, refuse — the
 * request-level "already_held" checks should have caught this earlier, so reaching here at all is unexpected.
 */

/** The Credential ledger object for (issuer, subject, typeHex), or null if none exists. */
async function existingCredential(client, issuer, subject, typeHex) {
  try {
    const r = await client.request({ command: 'ledger_entry', ledger_index: 'validated', credential: { subject, issuer, credential_type: typeHex } });
    return r.result.node;
  } catch (e) {
    if (/entryNotFound|not.*found/i.test(String(e.message))) return null;
    throw e;
  }
}

/** True if `node.Expiration` (Ripple time) is in the past. A credential with no Expiration field never expires. */
function isExpired(node, nowRippleSeconds) {
  return typeof node.Expiration === 'number' && node.Expiration <= nowRippleSeconds;
}

/**
 * If a credential already exists for (issuer, subject, typeHex):
 *   - not expired  -> throws (refuse to touch a live credential; the caller should not have reached this point)
 *   - expired      -> submits CredentialDelete from `wallet` (the issuer), waits for validation, and returns
 *                     { deleted: true, wasAccepted, reclaimedReserveTo } so the caller can log what reserve moved
 * If none exists, returns { deleted: false }.
 */
async function deleteExpiredCredentialIfAny(client, wallet, issuer, subject, typeHex, unixTimeToRippleTime) {
  const nowRipple = unixTimeToRippleTime(Date.now());
  const existing = await existingCredential(client, issuer, subject, typeHex);
  if (!existing) return { deleted: false };
  if (!isExpired(existing, nowRipple)) {
    const exp = existing.Expiration ? new Date((existing.Expiration + 946684800) * 1000).toISOString() : 'never';
    throw new Error(`A credential already exists for this subject and has not expired (expires ${exp}) — refusing to duplicate or delete a live credential.`);
  }
  const wasAccepted = (Number(existing.Flags || 0) & 0x00010000) !== 0; // lsfAccepted
  console.log(`  an EXPIRED credential already exists (accepted=${wasAccepted}) — deleting it first to unblock reissuance and reclaim its reserve...`);
  const tx = { TransactionType: 'CredentialDelete', Account: wallet.classicAddress, Issuer: issuer, Subject: subject, CredentialType: typeHex };
  const prepared = await client.autofill(tx);
  const signed = wallet.sign(prepared);
  const res = await client.submitAndWait(signed.tx_blob);
  const result = res.result.meta && res.result.meta.TransactionResult;
  if (result !== 'tesSUCCESS') throw new Error(`CredentialDelete of the expired credential failed: ${result}`);
  console.log(`  deleted (tx ${res.result.hash}) — 0.2 XRP reserve released to ${wasAccepted ? 'the subject' : 'the issuer'}.`);
  return { deleted: true, wasAccepted, txHash: res.result.hash };
}

module.exports = { existingCredential, isExpired, deleteExpiredCredentialIfAny };

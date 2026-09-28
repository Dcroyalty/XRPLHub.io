#!/usr/bin/env node
/* scripts/cleanup-unaccepted-credentials.mjs
 *
 * Reserve-recycling policy for XRPLHub's credential issuer (rmWjCGeLtuLGerEuvHDkrsr46ej2Ni13f):
 *
 *   Delete an UNACCEPTED credential once it has been EXPIRED for more than 7 days, across every io.xrplhub.*
 *   family (score, mpt-declared, screen-nomatch, domain-verified).
 *
 * WHY 7 DAYS, WHY UNACCEPTED-ONLY, WHY NOT BEFORE EXPIRY:
 *   - The 0.2 XRP reserve for an unaccepted credential sits on the ISSUER (docs/CREDENTIAL-SPEC.md §6). An accepted
 *     credential's reserve has already moved to the SUBJECT — that is their reserve to manage, not the issuer's
 *     problem, and deleting a subject's own kept credential without being asked is not this script's business.
 *     This script only ever touches credentials WITHOUT lsfAccepted set.
 *   - Deleting before expiry would be presumptuous: the subject might still accept right up to the last moment
 *     (the 30/90-day window exists for exactly that). Nothing is touched while it could still become useful.
 *   - 7 days past expiry is deliberately short (this credential family churns fast — screen-nomatch re-issues every
 *     30 days) and deliberately uniform across all four families, so the policy is one sentence, not a per-family
 *     table. Long enough to absorb any clock/timezone slop or a delayed operator run; short enough that reserve
 *     doesn't sit locked for weeks over a credential nobody was ever going to accept.
 *   - This is a hand-run script, not a cron job: the issuer's signing key (CREDENTIAL_ISSUER_SEED) is deliberately
 *     never on Vercel, so nothing that signs can run unattended. Run this periodically (e.g. alongside
 *     scripts/issue-queued-credentials.cjs) — it is idempotent and safe to run as often as you like.
 *
 * Walks the issuer's OWN account_objects (type: credential) — authoritative and complete, independent of our own
 * CredentialRequest tracking (which only knows what it itself queued; a walk of the ledger catches everything,
 * including anything issued by hand outside the normal flow).
 *
 *   node scripts/cleanup-unaccepted-credentials.mjs                 # list what qualifies (default; deletes nothing)
 *   node scripts/cleanup-unaccepted-credentials.mjs --delete        # delete every qualifying credential
 *   node scripts/cleanup-unaccepted-credentials.mjs --delete --grace-days 3   # override the grace period
 *
 * Reads CREDENTIAL_ISSUER_SEED from .env for --delete. The derived address MUST equal EXPECTED_ISSUER or it refuses.
 */
import 'dotenv/config';
import { Client, Wallet, convertHexToString, rippleTimeToUnixTime, unixTimeToRippleTime } from 'xrpl';

const EXPECTED_ISSUER = 'rmWjCGeLtuLGerEuvHDkrsr46ej2Ni13f';
const MAINNET_ENDPOINTS = ['wss://xrplcluster.com', 'wss://s1.ripple.com', 'wss://s2.ripple.com'];
const DEFAULT_GRACE_DAYS = 7;
const LSF_ACCEPTED = 0x00010000;

const args = process.argv.slice(2);
const doDelete = args.includes('--delete');
const graceIdx = args.indexOf('--grace-days');
const graceDays = graceIdx >= 0 ? Number(args[graceIdx + 1]) : DEFAULT_GRACE_DAYS;

async function connectMainnetOrThrow() {
  let lastErr;
  for (const wss of MAINNET_ENDPOINTS) {
    const client = new Client(wss);
    try {
      await client.connect();
      const info = await client.request({ command: 'server_info' });
      if (info.result.info.network_id !== 0) throw new Error(`REFUSING: ${wss} network_id != 0`);
      return client;
    } catch (e) {
      await client.disconnect().catch(() => {});
      if (String(e.message).startsWith('REFUSING')) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error('no mainnet node reachable');
}

/** Every Credential object owned by the issuer (account_objects paginates; this follows `marker`). */
async function allIssuerCredentials(client) {
  const out = [];
  let marker;
  do {
    const r = await client.request({ command: 'account_objects', account: EXPECTED_ISSUER, ledger_index: 'validated', type: 'credential', limit: 200, ...(marker ? { marker } : {}) });
    out.push(...r.result.account_objects);
    marker = r.result.marker;
  } while (marker);
  return out;
}

(async () => {
  const client = await connectMainnetOrThrow();
  try {
    const nowRipple = unixTimeToRippleTime(Date.now());
    const graceSeconds = graceDays * 86400;
    const all = await allIssuerCredentials(client);
    const qualifying = all.filter((n) => {
      const accepted = (Number(n.Flags || 0) & LSF_ACCEPTED) !== 0;
      const expiredSeconds = typeof n.Expiration === 'number' ? nowRipple - n.Expiration : -Infinity; // no Expiration = never qualifies
      return !accepted && expiredSeconds > graceSeconds;
    });

    console.log(`issuer holds ${all.length} credential(s) total; ${qualifying.length} qualify for deletion (unaccepted, expired > ${graceDays}d ago):\n`);
    for (const n of qualifying) {
      const type = (() => { try { return convertHexToString(n.CredentialType); } catch { return n.CredentialType; } })();
      const expISO = n.Expiration ? new Date(rippleTimeToUnixTime(n.Expiration)).toISOString() : 'never';
      console.log(`  ${n.Subject}  ${type}  expired ${expISO}  (index ${n.index})`);
    }
    if (qualifying.length === 0) { console.log('\nNothing to do.'); return; }
    console.log(`\nDeleting all of them would release ${(qualifying.length * 0.2).toFixed(1)} XRP of issuer reserve.`);

    if (!doDelete) { console.log('\n(list only — add --delete to actually delete them)'); return; }

    const seed = process.env.CREDENTIAL_ISSUER_SEED;
    if (!seed) throw new Error('CREDENTIAL_ISSUER_SEED not set in .env');
    const wallet = Wallet.fromSeed(seed);
    if (wallet.classicAddress !== EXPECTED_ISSUER) throw new Error(`REFUSING: seed derives ${wallet.classicAddress}, expected ${EXPECTED_ISSUER}`);

    let deleted = 0;
    for (const n of qualifying) {
      try {
        const tx = { TransactionType: 'CredentialDelete', Account: EXPECTED_ISSUER, Issuer: EXPECTED_ISSUER, Subject: n.Subject, CredentialType: n.CredentialType };
        const prepared = await client.autofill(tx);
        const signed = wallet.sign(prepared);
        const res = await client.submitAndWait(signed.tx_blob);
        const result = res.result.meta && res.result.meta.TransactionResult;
        if (result === 'tesSUCCESS') { console.log(`  deleted ${n.Subject} / ${n.CredentialType} (tx ${res.result.hash})`); deleted++; }
        else console.log(`  FAILED ${n.Subject} / ${n.CredentialType}: ${result}`);
      } catch (e) {
        console.log(`  FAILED ${n.Subject} / ${n.CredentialType}: ${e.message}`);
      }
    }
    console.log(`\ndeleted ${deleted}/${qualifying.length} — reclaimed ~${(deleted * 0.2).toFixed(1)} XRP of issuer reserve.`);
  } finally {
    await client.disconnect().catch(() => {});
  }
})().catch((e) => { console.error('\nERROR:', e.message); process.exit(1); });

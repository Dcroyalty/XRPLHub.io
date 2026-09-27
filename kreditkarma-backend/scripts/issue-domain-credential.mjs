#!/usr/bin/env node
/* scripts/issue-domain-credential.mjs
 *
 * One-off, hand-run mainnet issuance of an io.xrplhub.domain.v1.verified credential — attests that, at issuance, the
 * subject's own ledger Domain field AND that domain's xrp-ledger.toml confirmed a two-way link. Mirrors
 * scripts/issue-credential.cjs (the score credential's script) in structure and rigor.
 *
 * .mjs, not .cjs, so it can import src/lib/domainVerify.ts directly (see scripts/ts-hooks.mjs below) — the exact
 * same real, comment-safe, table-scoped [[ACCOUNTS]] parse the live site runs, not a second implementation.
 *
 *   node scripts/issue-domain-credential.mjs plan   <subjectAddress>   # re-check + build, no tx (default)
 *   node scripts/issue-domain-credential.mjs issue  <subjectAddress>   # re-check, refuse if it no longer holds, SIGN + SUBMIT
 *   node scripts/issue-domain-credential.mjs verify <subjectAddress>   # ledger_entry read-back
 *
 * The domain link can change (DNS reassigned, toml edited, Domain field cleared) between when a request was queued
 * and when a person gets to it, so `issue` ALWAYS re-checks both directions immediately before signing.
 *
 * Reads CREDENTIAL_ISSUER_SEED from .env. The derived address MUST equal EXPECTED_ISSUER or it refuses.
 */
import 'dotenv/config';
import './ts-hooks.mjs'; // registers the @/ alias + extensionless-import resolver for the import below
import { Client, Wallet, convertStringToHex, convertHexToString, unixTimeToRippleTime, rippleTimeToUnixTime } from 'xrpl';

const REPO_ROOT = new URL('../', import.meta.url);
const { verifyDomainTwoWay } = await import(new URL('src/lib/domainVerify.ts', REPO_ROOT).href);

const MAINNET_NETWORK_ID = 0;
const MAINNET_ENDPOINTS = ['wss://xrplcluster.com', 'wss://s1.ripple.com', 'wss://s2.ripple.com'];
const EXPECTED_ISSUER = 'rmWjCGeLtuLGerEuvHDkrsr46ej2Ni13f';
const CRED_TYPE = 'io.xrplhub.domain.v1.verified';
const VALIDITY_DAYS = 90;
const ORIGIN = 'https://www.xrplhub.io';
const verificationUri = (subject) => `${ORIGIN}/verify/domain/${subject}`;

async function connectMainnetOrThrow() {
  let lastErr;
  for (const wss of MAINNET_ENDPOINTS) {
    const client = new Client(wss);
    try {
      await client.connect();
      if (client.networkID !== undefined && client.networkID !== MAINNET_NETWORK_ID) {
        throw new Error(`REFUSING: ${wss} client.networkID=${client.networkID}, expected 0`);
      }
      const info = await client.request({ command: 'server_info' });
      const i = info.result.info;
      if (i.network_id !== MAINNET_NETWORK_ID) throw new Error(`REFUSING: ${wss} server_info network_id=${i.network_id}, expected 0`);
      if (!i.validated_ledger || !i.validated_ledger.seq) throw new Error(`REFUSING: ${wss} has no validated ledger`);
      return client;
    } catch (e) {
      await client.disconnect().catch(() => {});
      if (String(e.message).startsWith('REFUSING')) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error('no mainnet node reachable');
}

async function declaredDomain(client, address) {
  const r = await client.request({ command: 'account_info', account: address, ledger_index: 'validated' });
  const hex = r.result.account_data.Domain;
  if (!hex) return null;
  try { return Buffer.from(hex, 'hex').toString('utf8'); } catch { return null; }
}

function buildPlan(subject) {
  if (subject === EXPECTED_ISSUER) throw new Error('issuer must not equal subject');
  const typeHex = convertStringToHex(CRED_TYPE).toUpperCase();
  const nowMs = Date.now();
  const expirationRipple = unixTimeToRippleTime(nowMs + VALIDITY_DAYS * 86400000);
  const uri = verificationUri(subject);
  const uriHex = convertStringToHex(uri).toUpperCase();
  if (uriHex.length / 2 > 256) throw new Error('URI too long');
  const txjson = { TransactionType: 'CredentialCreate', Account: EXPECTED_ISSUER, Subject: subject, CredentialType: typeHex, Expiration: expirationRipple, URI: uriHex };
  return { issuer: EXPECTED_ISSUER, subject, credentialType: CRED_TYPE, credentialTypeHex: typeHex, expirationRipple, expirationISO: new Date(rippleTimeToUnixTime(expirationRipple)).toISOString(), uri, uriHex, uriBytes: uriHex.length / 2, txjson };
}

async function issuerAccount(client) {
  try {
    const r = await client.request({ command: 'account_info', account: EXPECTED_ISSUER, ledger_index: 'validated' });
    const a = r.result.account_data;
    return { activated: true, balanceXRP: Number(a.Balance) / 1e6, ownerCount: a.OwnerCount, sequence: a.Sequence };
  } catch (e) {
    if (/actNotFound/.test(JSON.stringify(e))) return { activated: false };
    throw e;
  }
}

function printPlan(plan, domain, check) {
  console.log('\n─── DOMAIN-CREDENTIAL ISSUANCE PLAN ────────────────────────────');
  console.log('  issuer          ', plan.issuer);
  console.log('  subject         ', plan.subject);
  console.log('  declared domain ', domain || '(none)');
  console.log('  two-way check   ', check ? (check.ok ? 'VERIFIED' : `NOT VERIFIED — ${check.reason}`) : 'skipped (no domain)');
  console.log('  CredentialType  ', plan.credentialType);
  console.log('  ...hex          ', plan.credentialTypeHex);
  console.log('  Expiration      ', plan.expirationRipple, `(ripple)  =  ${plan.expirationISO}  (${VALIDITY_DAYS}-day validity)`);
  console.log('  URI             ', plan.uri);
  console.log('  ...hex          ', plan.uriHex, `(${plan.uriBytes} bytes)`);
  console.log('  txjson          ', JSON.stringify(plan.txjson));
  console.log('─────────────────────────────────────────────────────────────\n');
}

(async () => {
  const [mode, subject] = process.argv.slice(2);
  if (!subject || !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(subject)) {
    console.error('usage: node scripts/issue-domain-credential.mjs <plan|issue|verify> <subjectAddress>');
    process.exit(1);
  }

  if (mode === 'verify') {
    const client = await connectMainnetOrThrow();
    try {
      const led = await client.request({ command: 'ledger', ledger_index: 'validated' });
      const typeHex = convertStringToHex(CRED_TYPE).toUpperCase();
      let node = null;
      try {
        const r = await client.request({ command: 'ledger_entry', ledger_index: 'validated', credential: { subject, issuer: EXPECTED_ISSUER, credential_type: typeHex } });
        node = r.result.node;
      } catch (e) {
        if (!/entryNotFound|not.*found/i.test(String(e.message))) throw e;
      }
      console.log(`\nvalidated ledger #${led.result.ledger_index}`);
      if (!node) { console.log('NO io.xrplhub.domain.v1.verified credential found from', EXPECTED_ISSUER, 'for', subject); }
      else {
        const flags = Number(node.Flags || 0);
        console.log('FOUND');
        console.log('  Issuer         ', node.Issuer);
        console.log('  Subject        ', node.Subject);
        console.log('  CredentialType ', convertHexToString(node.CredentialType), `(${node.CredentialType})`);
        console.log('  Expiration     ', node.Expiration, '=', new Date(rippleTimeToUnixTime(node.Expiration)).toISOString());
        console.log('  URI            ', node.URI ? convertHexToString(node.URI) : '(none)');
        console.log('  Flags          ', flags, '  lsfAccepted(0x00010000):', (flags & 0x00010000) !== 0);
        console.log('  LedgerEntry idx', node.index);
      }
    } finally { await client.disconnect().catch(() => {}); }
    return;
  }

  const client = await connectMainnetOrThrow();
  let domain = null, check = null;
  try {
    domain = await declaredDomain(client, subject);
    if (domain) check = await verifyDomainTwoWay(domain, subject);

    const plan = buildPlan(subject);
    printPlan(plan, domain, check);

    if (!domain) { console.error('REFUSING: no Domain field set on this account right now. Not issuing.'); process.exit(1); }
    if (!check.ok) { console.error('REFUSING:', check.reason, '— Not issuing.'); process.exit(1); }

    const acct = await issuerAccount(client);
    console.log('issuer account:', JSON.stringify(acct));
    const fee = await client.request({ command: 'server_info' });
    const vl = fee.result.info.validated_ledger;
    console.log(`mainnet: build ${fee.result.info.build_version}, reserve_base ${vl.reserve_base_xrp} XRP, reserve_inc ${vl.reserve_inc_xrp} XRP\n`);

    if (mode !== 'issue') { console.log('(plan only — run with `issue` to sign + submit)'); return; }

    const seed = process.env.CREDENTIAL_ISSUER_SEED;
    if (!seed) throw new Error('CREDENTIAL_ISSUER_SEED not set in .env');
    const wallet = Wallet.fromSeed(seed);
    if (wallet.classicAddress !== EXPECTED_ISSUER) throw new Error(`REFUSING: seed derives ${wallet.classicAddress}, expected ${EXPECTED_ISSUER}`);
    if (!acct.activated) throw new Error('Issuer wallet is not funded/activated yet.');

    const prepared = await client.autofill(plan.txjson);
    console.log('prepared:', JSON.stringify(prepared));
    const signed = wallet.sign(prepared);
    console.log('\nsubmitting…');
    const res = await client.submitAndWait(signed.tx_blob);
    const meta = res.result.meta;
    console.log('\n─── RESULT ──────────────────────────────────────────────────');
    console.log('  engine result  ', meta && meta.TransactionResult);
    console.log('  tx hash        ', res.result.hash);
    console.log('  validated      ', res.result.validated);
    console.log('  ledger index   ', res.result.ledger_index);
    console.log('  fee (drops)    ', prepared.Fee);
    console.log('  explorer       ', `https://livenet.xrpl.org/transactions/${res.result.hash}`);
    console.log('─────────────────────────────────────────────────────────────\n');
  } finally {
    await client.disconnect().catch(() => {});
  }
})().catch((e) => { console.error('\nERROR:', e.message); process.exit(1); });

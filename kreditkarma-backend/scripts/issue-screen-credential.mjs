#!/usr/bin/env node
/* scripts/issue-screen-credential.mjs
 *
 * One-off, hand-run mainnet issuance of an io.xrplhub.screen.v2.nomatch credential — attests only that, at issuance,
 * the subject did not appear on the current snapshot of every sanctions list XRPLHub screens. NEVER "clean",
 * NEVER a compliance determination — see src/lib/screenCredential.ts and src/lib/screen.ts SCREEN_DISCLAIMER_SHORT.
 * Mirrors scripts/issue-credential.cjs (the score credential's script) in structure and rigor.
 *
 * .mjs, not .cjs, because it re-screens by calling screenAll() directly — the exact same engine the live site runs,
 * not a second reimplementation — which means importing real TypeScript (see scripts/ts-hooks.mjs, imported below
 * for its module-loading side effect; run this with plain `node`, no --import flag needed).
 *
 *   node scripts/issue-screen-credential.mjs plan   <subjectAddress>   # re-screen + build, no tx (default)
 *   node scripts/issue-screen-credential.mjs issue  <subjectAddress>   # re-screen, refuse if listed, SIGN + SUBMIT
 *   node scripts/issue-screen-credential.mjs verify <subjectAddress>   # ledger_entry read-back
 *
 * Unlike the MPT-declared credential, the fact this attests DOES change day to day (lists update), so `issue` ALWAYS
 * re-screens immediately before signing and refuses if the address is listed at that moment — the queued request's
 * screen (possibly hours or days old) is never trusted for the actual issuance decision.
 *
 * Reads CREDENTIAL_ISSUER_SEED and DATABASE_URL from .env (production!). The derived issuer address MUST equal
 * EXPECTED_ISSUER or it refuses.
 */
import 'dotenv/config';
import './ts-hooks.mjs'; // registers the @/ alias + extensionless-import resolver for the imports below
import { Client, Wallet, convertStringToHex, convertHexToString, unixTimeToRippleTime, rippleTimeToUnixTime } from 'xrpl';
import { createRequire } from 'node:module';

const REPO_ROOT = new URL('../', import.meta.url); // this file is repo/scripts/…
const require = createRequire(new URL('package.json', REPO_ROOT));
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const src = (f) => new URL(`src/lib/${f}`, REPO_ROOT).href;
const { screenAll } = await import(src('screen.ts'));

const MAINNET_NETWORK_ID = 0;
const MAINNET_ENDPOINTS = ['wss://xrplcluster.com', 'wss://s1.ripple.com', 'wss://s2.ripple.com'];
const EXPECTED_ISSUER = 'rmWjCGeLtuLGerEuvHDkrsr46ej2Ni13f';
const CRED_TYPE = 'io.xrplhub.screen.v2.nomatch';
const VALIDITY_DAYS = 30;
const ORIGIN = 'https://www.xrplhub.io';
const verificationUri = (subject) => `${ORIGIN}/verify/screening/${subject}`;

async function screenLive(address) {
  const outcome = await screenAll(prisma, address, 'operator:issue-screen-credential', {});
  return { listed: outcome.leaf.result.listed, statement: outcome.statement, queryId: outcome.queryId };
}

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

function printPlan(plan, screen) {
  console.log('\n─── SCREEN-CREDENTIAL ISSUANCE PLAN ────────────────────────────');
  console.log('  issuer          ', plan.issuer);
  console.log('  subject         ', plan.subject);
  console.log('  live screen     ', screen.listed ? 'LISTED — refusing' : 'no match', ' (queryId', screen.queryId, ')');
  console.log('  statement       ', screen.statement);
  console.log('  CredentialType  ', plan.credentialType, '— "no match", never "clean" or "verified"');
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
    console.error('usage: node scripts/issue-screen-credential.mjs <plan|issue|verify> <subjectAddress>');
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
      if (!node) { console.log('NO io.xrplhub.screen.v2.nomatch credential found from', EXPECTED_ISSUER, 'for', subject); }
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
    await prisma.$disconnect();
    return;
  }

  const screen = await screenLive(subject);
  const plan = buildPlan(subject);
  printPlan(plan, screen);
  if (screen.listed) {
    await prisma.$disconnect();
    console.error('REFUSING: this address appears on a current list snapshot right now. Not issuing.');
    process.exit(1);
  }

  const client = await connectMainnetOrThrow();
  try {
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
    await prisma.$disconnect();
  }
})().catch(async (e) => { console.error('\nERROR:', e.message); await prisma.$disconnect().catch(() => {}); process.exit(1); });

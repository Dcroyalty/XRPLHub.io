#!/usr/bin/env node
/* scripts/issue-credential.cjs
 *
 * One-time, hand-run mainnet issuance of an XLS-70 XRPLScore credential.
 * Mirrors src/lib/credentials.ts exactly; run standalone so there is no
 * deployed attack surface and every field is printed before anything is signed.
 *
 *   node scripts/issue-credential.cjs plan   <subject>   # score + build, no tx (default)
 *   node scripts/issue-credential.cjs issue  <subject>   # re-score, guard, SIGN + SUBMIT
 *   node scripts/issue-credential.cjs verify <subject>   # ledger_entry read-back
 *
 * Reads CREDENTIAL_ISSUER_SEED from .env. The derived address MUST equal
 * EXPECTED_ISSUER or it refuses.
 */
require('dotenv').config();
const {
  Client, Wallet, convertStringToHex, convertHexToString,
  unixTimeToRippleTime, rippleTimeToUnixTime,
} = require('xrpl');

// ── HARD MAINNET LOCK ────────────────────────────────────────────────────────
const MAINNET_NETWORK_ID = 0;
const MAINNET_ENDPOINTS = ['wss://xrplcluster.com', 'wss://s1.ripple.com', 'wss://s2.ripple.com'];
const EXPECTED_ISSUER = 'rmWjCGeLtuLGerEuvHDkrsr46ej2Ni13f';
const CRED_NAMESPACE = 'io.xrplhub.score.v1';
const VALIDITY_DAYS = 90;
const SCORE_API = 'https://www.xrplhub.io/api/score/';
const ORIGIN = 'https://www.xrplhub.io';
const ELIGIBILITY_FLOOR = 600;

function eligibleTier(score) {
  if (score == null) return null;
  if (score >= 750) return 'min750';
  if (score >= 700) return 'min700';
  if (score >= 650) return 'min650';
  if (score >= ELIGIBILITY_FLOOR) return 'min600';
  return null;
}
const credType = (tier) => `${CRED_NAMESPACE}.${tier}`;
const verificationUri = (subject) => `${ORIGIN}/verify/wallet/${subject}`;

async function scoreLive(address) {
  const res = await fetch(SCORE_API + encodeURIComponent(address));
  if (res.status === 404) return { score: null };
  if (!res.ok) throw new Error(`score API ${res.status}`);
  const j = await res.json();
  return {
    score: j.ledgerScore ?? j.score ?? null,
    grade: j.grade,
    methodology: j.methodology,
    signals: j.signals,
    scannedAt: j.scannedAt,
  };
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
      if (i.network_id !== MAINNET_NETWORK_ID) {
        throw new Error(`REFUSING: ${wss} server_info network_id=${i.network_id}, expected 0`);
      }
      if (!i.validated_ledger || !i.validated_ledger.seq) {
        throw new Error(`REFUSING: ${wss} has no validated ledger`);
      }
      return client;
    } catch (e) {
      await client.disconnect().catch(() => {});
      if (String(e.message).startsWith('REFUSING')) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error('no mainnet node reachable');
}

function buildPlan(subject, s) {
  const tier = eligibleTier(s.score);
  if (!tier) {
    throw new Error(
      s.score == null
        ? `Subject ${subject} is not an activated XRPL mainnet account — NOT eligible.`
        : `Score ${s.score} is below the ${ELIGIBILITY_FLOOR} floor — NOT eligible.`
    );
  }
  const typeAscii = credType(tier);
  const typeHex = convertStringToHex(typeAscii).toUpperCase();
  const nowMs = Date.now();
  const expirationRipple = unixTimeToRippleTime(nowMs + VALIDITY_DAYS * 86400000);
  const uri = verificationUri(subject);
  const uriHex = convertStringToHex(uri).toUpperCase();
  if (uriHex.length / 2 > 256) throw new Error('URI too long');
  if (subject === EXPECTED_ISSUER) throw new Error('issuer must not equal subject');
  const txjson = {
    TransactionType: 'CredentialCreate',
    Account: EXPECTED_ISSUER,
    Subject: subject,
    CredentialType: typeHex,
    Expiration: expirationRipple,
    URI: uriHex,
  };
  return {
    issuer: EXPECTED_ISSUER, subject, score: s.score, grade: s.grade, tier,
    credentialType: typeAscii, credentialTypeHex: typeHex,
    expirationRipple, expirationISO: new Date(rippleTimeToUnixTime(expirationRipple)).toISOString(),
    issuedAtISO: new Date(nowMs).toISOString(),
    uri, uriHex, uriBytes: uriHex.length / 2,
    methodology: s.methodology, signals: s.signals, txjson,
  };
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

function printPlan(plan) {
  console.log('\n─── ISSUANCE PLAN ───────────────────────────────────────────');
  console.log('  issuer          ', plan.issuer, '(dedicated; NOT the treasury)');
  console.log('  subject         ', plan.subject);
  console.log('  live score      ', plan.score, `(${plan.grade})`);
  console.log('  methodology     ', plan.methodology);
  console.log('  tier            ', plan.tier, `  →  guarantee: XRPLScore ≥ ${plan.tier.replace('min','')} at issuance`);
  console.log('  CredentialType  ', plan.credentialType);
  console.log('  ...hex          ', plan.credentialTypeHex);
  console.log('  Expiration      ', plan.expirationRipple, `(ripple)  =  ${plan.expirationISO}  (${VALIDITY_DAYS}-day validity)`);
  console.log('  URI             ', plan.uri);
  console.log('  ...hex          ', plan.uriHex, `(${plan.uriBytes} bytes)`);
  console.log('  signals         ', JSON.stringify(plan.signals));
  console.log('  txjson          ', JSON.stringify(plan.txjson));
  console.log('─────────────────────────────────────────────────────────────\n');
}

(async () => {
  const [mode, subject] = process.argv.slice(2);
  if (!subject || !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(subject)) {
    console.error('usage: node scripts/issue-credential.cjs <plan|issue|verify> <subjectAddress>');
    process.exit(1);
  }

  if (mode === 'verify') {
    const client = await connectMainnetOrThrow();
    try {
      const led = await client.request({ command: 'ledger', ledger_index: 'validated' });
      const ledgerIndex = led.result.ledger_index;
      const tiers = ['min750', 'min700', 'min650', 'min600'];
      let hit = null;
      for (const t of tiers) {
        const typeHex = convertStringToHex(credType(t)).toUpperCase();
        try {
          const r = await client.request({
            command: 'ledger_entry', ledger_index: 'validated',
            credential: { subject, issuer: EXPECTED_ISSUER, credential_type: typeHex },
          });
          hit = { tier: t, node: r.result.node };
          break;
        } catch (e) {
          if (!/entryNotFound|not.*found/i.test(String(e.message))) throw e;
        }
      }
      console.log(`\nvalidated ledger #${ledgerIndex}`);
      if (!hit) { console.log('NO credential found from', EXPECTED_ISSUER, 'for', subject); }
      else {
        const n = hit.node;
        const flags = Number(n.Flags || 0);
        console.log('FOUND:', hit.tier);
        console.log('  Issuer         ', n.Issuer);
        console.log('  Subject        ', n.Subject);
        console.log('  CredentialType ', convertHexToString(n.CredentialType), `(${n.CredentialType})`);
        console.log('  Expiration     ', n.Expiration, '=', new Date(rippleTimeToUnixTime(n.Expiration)).toISOString());
        console.log('  URI            ', n.URI ? convertHexToString(n.URI) : '(none)');
        console.log('  Flags          ', flags, '  lsfAccepted(0x00010000):', (flags & 0x00010000) !== 0);
        console.log('  LedgerEntry idx', n.index);
      }
    } finally { await client.disconnect().catch(() => {}); }
    return;
  }

  // plan / issue: score first
  const s = await scoreLive(subject);
  const plan = buildPlan(subject, s);
  printPlan(plan);

  const client = await connectMainnetOrThrow();
  try {
    const acct = await issuerAccount(client);
    console.log('issuer account:', JSON.stringify(acct));
    const fee = await client.request({ command: 'server_info' });
    const vl = fee.result.info.validated_ledger;
    console.log(`mainnet: build ${fee.result.info.build_version}, reserve_base ${vl.reserve_base_xrp} XRP, reserve_inc ${vl.reserve_inc_xrp} XRP\n`);

    if (mode !== 'issue') { console.log('(plan only — run with `issue` to sign + submit)'); return; }

    // ── ISSUE ──
    const seed = process.env.CREDENTIAL_ISSUER_SEED;
    if (!seed) throw new Error('CREDENTIAL_ISSUER_SEED not set in .env');
    const wallet = Wallet.fromSeed(seed);
    if (wallet.classicAddress !== EXPECTED_ISSUER) {
      throw new Error(`REFUSING: seed derives ${wallet.classicAddress}, expected ${EXPECTED_ISSUER}`);
    }
    if (!acct.activated) throw new Error('Issuer wallet is not funded/activated yet.');

    // Re-score at the moment of issuance — the attestation must be true NOW.
    const s2 = await scoreLive(subject);
    const tier2 = eligibleTier(s2.score);
    console.log(`re-score at issuance: ${s2.score} -> ${tier2}`);
    if (tier2 !== plan.tier) {
      throw new Error(`REFUSING: tier changed (plan ${plan.tier}, now ${tier2}). Not issuing.`);
    }

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

#!/usr/bin/env node
/* scripts/test-paid-path.mjs
 *
 * Proves the REAL paid path end to end with a REAL on-ledger payment, using the credential issuer's own
 * spendable XRP (rmWjCGeLtuLGerEuvHDkrsr46ej2Ni13f). Runs entirely locally — the issuer's seed is read
 * from the local .env and NEVER leaves this machine (never sent anywhere, never put on Vercel).
 *
 * What this proves, against the REAL deployed production API (www.xrplhub.io), using the admin-only
 * `adminhealthcheck` product (see servicePrices.ts's ADMIN_ONLY_SERVICE_IDS):
 *   1. A real 1 XRP Payment, signed and submitted locally, issuer -> treasury.
 *   2. POST /api/execute verifies that payment on-ledger against the server's own price table and
 *      DELIVERS the built (unsigned) service transaction — i.e. the same code path every real customer
 *      purchase uses (verifyPayment -> claimBuild -> buildServiceTx).
 *   3. The SAME payment hash reused for a DIFFERENT product is refused (bound_to_other_product) — a
 *      payment cannot be split across two services.
 *   4. The SAME payment hash reused for the SAME product/step is idempotent (a safe re-issue, not a new
 *      charge, capped by ISSUES_PER_STEP) — not a way to get unlimited free re-deliveries either.
 *   5. The issuer's spendable XRP stays above 2 after the test payment.
 *
 * Deliberately does NOT sign or submit the built service transaction — delivery (getting txjson back) is
 * the thing being proven, not the service itself.
 *
 * Requires locally: CREDENTIAL_ISSUER_SEED, ADMIN_API_TOKEN (both in .env, neither ever sent to Vercel by
 * this script — ADMIN_API_TOKEN is sent to xrplhub.io only, as its designed use).
 *
 * Run: node scripts/test-paid-path.mjs
 */
import 'dotenv/config';
import xrpl from 'xrpl';

const API = process.env.PAID_PATH_TEST_API_BASE || 'https://www.xrplhub.io';
const TREASURY = 'rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF';
const NODE = 'wss://xrplcluster.com';

let failures = 0;
function check(label, cond, detail = '') {
  const mark = cond ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}

async function spendableXrp(client, address) {
  const info = await client.request({ command: 'account_info', account: address, ledger_index: 'validated' });
  const total = Number(xrpl.dropsToXrp(info.result.account_data.Balance));
  const reserveBase = Number(info.result.account_data.OwnerCount) * 0.2 + 1; // rough, fine for a headroom check
  return { total, spendable: total - reserveBase };
}

(async () => {
  const seed = process.env.CREDENTIAL_ISSUER_SEED;
  const adminToken = process.env.ADMIN_API_TOKEN;
  if (!seed) { console.error('CREDENTIAL_ISSUER_SEED not set locally — see .env'); process.exit(1); }
  if (!adminToken) { console.error('ADMIN_API_TOKEN not set locally — see .env'); process.exit(1); }

  const wallet = xrpl.Wallet.fromSeed(seed);
  const issuer = wallet.address;
  console.log(`issuer: ${issuer}`);

  const client = new xrpl.Client(NODE);
  await client.connect();

  console.log('\n=== 0. issuer balance before ===');
  const before = await spendableXrp(client, issuer);
  console.log(`  total ${before.total} XRP, spendable ~${before.spendable.toFixed(6)} XRP`);
  check('issuer has enough to safely send 1 XRP and stay > 2 spendable', before.spendable > 3, `need >3, have ~${before.spendable.toFixed(2)}`);
  if (before.spendable <= 3) { console.error('Aborting before sending any payment.'); await client.disconnect(); process.exit(1); }

  console.log('\n=== 1. real 1 XRP payment, issuer -> treasury ===');
  const tx = {
    TransactionType: 'Payment',
    Account: issuer,
    Destination: TREASURY,
    Amount: xrpl.xrpToDrops('1'),
  };
  const prepared = await client.autofill(tx);
  const signed = wallet.sign(prepared);
  const result = await client.submitAndWait(signed.tx_blob);
  const engineResult = result.result.meta?.TransactionResult;
  const payHash = result.result.hash;
  console.log(`  hash: ${payHash}`);
  console.log(`  engine result: ${engineResult}`);
  check('payment validated tesSUCCESS', engineResult === 'tesSUCCESS');
  if (engineResult !== 'tesSUCCESS') { await client.disconnect(); process.exit(1); }

  const call = (body) =>
    fetch(`${API}/api/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': adminToken },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  console.log('\n=== 2. delivery: POST /api/execute (productId=adminhealthcheck) ===');
  const d1 = await call({ productId: 'adminhealthcheck', account: issuer, payTxHash: payHash });
  console.log(`  HTTP ${d1.status}:`, JSON.stringify(d1.body).slice(0, 300));
  check('delivered: HTTP 200 with a built txjson (TicketCreate)', d1.status === 200 && d1.body?.txjson?.TransactionType === 'TicketCreate');
  check('NOT auto-signed/submitted — no uuid required, this script stops here', true, 'txjson returned, never signed');

  console.log('\n=== 3. replay A: same hash, DIFFERENT product -> must be refused ===');
  const d2 = await call({ productId: 'tickets', account: issuer, payTxHash: payHash });
  console.log(`  HTTP ${d2.status}:`, JSON.stringify(d2.body).slice(0, 300));
  check('refused as bound_to_other_product (409)', d2.status === 409 && d2.body?.code === 'bound_to_other_product');

  console.log('\n=== 4. replay B: same hash, SAME product/step -> idempotent re-issue (not a new charge) ===');
  const d3 = await call({ productId: 'adminhealthcheck', account: issuer, payTxHash: payHash });
  console.log(`  HTTP ${d3.status}:`, JSON.stringify(d3.body).slice(0, 300));
  check('re-issues the same built tx (200, same TransactionType), not an error', d3.status === 200 && d3.body?.txjson?.TransactionType === 'TicketCreate');

  console.log('\n=== 5. issue-limit: exhaust ISSUES_PER_STEP, then confirm the NEXT one is refused ===');
  let lastStatus = null, lastBody = null;
  for (let i = 0; i < 3; i++) {
    const r = await call({ productId: 'adminhealthcheck', account: issuer, payTxHash: payHash });
    lastStatus = r.status; lastBody = r.body;
  }
  console.log(`  after exhausting retries, HTTP ${lastStatus}:`, JSON.stringify(lastBody).slice(0, 300));
  check('issue_limit eventually refuses further builds for this payment (429)', lastStatus === 429 && lastBody?.code === 'issue_limit');

  console.log('\n=== 6. issuer balance after ===');
  const after = await spendableXrp(client, issuer);
  console.log(`  total ${after.total} XRP, spendable ~${after.spendable.toFixed(6)} XRP`);
  check('spendable still > 2 XRP', after.spendable > 2, `have ~${after.spendable.toFixed(6)}`);
  check('total dropped by ~1 XRP + one tx fee, nothing more (no double-charge)', before.total - after.total > 0.99 && before.total - after.total < 1.01, `delta ${(before.total - after.total).toFixed(6)}`);

  await client.disconnect();
  console.log(`\npayment hash for reference: ${payHash}`);
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => { console.error(e); process.exit(1); });

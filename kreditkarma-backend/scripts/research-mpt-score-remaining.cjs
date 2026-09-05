#!/usr/bin/env node
/* RESEARCH ONLY. Score the union MPT issuers NOT already in
 * .mpt-issuer-risk.json — MPT flags from account_objects (authoritative
 * current state), score+credentials from deployed xrplhub.io, domain/blackhole
 * from account_info. Merges into .mpt-issuer-risk.json. Resumable.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');

const RPC = ['https://xrplcluster.com', 'https://s1.ripple.com:51234', 'https://s2.ripple.com:51234', 'https://xrpl.ws'];
const ORIGIN = 'https://www.xrplhub.io';
const RISK_FILE = path.join(__dirname, '.mpt-issuer-risk.json');
const RECON_FILE = path.join(__dirname, '.bithomp-reconcile.json');
const LSF_DISABLE_MASTER = 0x00100000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function hexToStr(h) { try { return Buffer.from(h, 'hex').toString('utf8'); } catch { return h; } }

async function rpc(method, params, attempts = 6) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(RPC[i % RPC.length], {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, params: [params] }), signal: AbortSignal.timeout(20000),
      });
      const j = await res.json();
      if (j.result?.error === 'tooBusy' || j.result?.status === 'error') throw new Error(j.result?.error);
      return j.result;
    } catch (e) { lastErr = e; await sleep(2000 * (i + 1)); }
  }
  throw lastErr;
}
async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
}

async function main() {
  const risk = JSON.parse(fs.readFileSync(RISK_FILE, 'utf8'));
  const recon = JSON.parse(fs.readFileSync(RECON_FILE, 'utf8'));
  const allIssuers = Object.keys(recon);
  const todo = allIssuers.filter(i => !risk[i]);
  console.error(`${todo.length} issuers to score (of ${allIssuers.length} union).`);

  for (const issuer of todo) {
    const row = { issuer, source: 'bithomp-only (not in our state walk)' };

    // MPT flags from account_objects — authoritative current state.
    // The type filter still pages through the WHOLE owner directory, so
    // issuers with many trust lines need marker follow-through.
    try {
      const objs = [];
      let marker;
      for (let pg = 0; pg < 12; pg++) {
        const ao = await rpc('account_objects', { account: issuer, type: 'mpt_issuance', ledger_index: 'validated', limit: 400, ...(marker ? { marker } : {}) });
        objs.push(...(ao.account_objects || []));
        marker = ao.marker;
        if (!marker) break;
      }
      let clawback = 0, canLock = 0, locked = 0, requireAuth = 0, noTransfer = 0;
      const meta = [];
      for (const o of objs) {
        const fl = Number(o.Flags || 0);
        if (fl & 0x40) clawback++;
        if (fl & 0x02) canLock++;
        if (fl & 0x01) locked++;
        if (fl & 0x04) requireAuth++;
        if (!(fl & 0x20)) noTransfer++;
        if (o.MPTokenMetadata) meta.push(hexToStr(o.MPTokenMetadata).replace(/\s+/g, ' ').slice(0, 120));
      }
      row.mpts = objs.length;
      row.flags = { count: objs.length, clawback, canLock, locked, requireAuth, noTransfer };
      row.mptMetaSample = meta.slice(0, 2);
    } catch (e) { row.aoError = String(e.message || e); row.mpts = recon[issuer].bithompCount; row.flags = { count: 0, clawback: '?', canLock: '?', locked: '?', requireAuth: '?', noTransfer: '?' }; }

    // account_info
    try {
      const ai = await rpc('account_info', { account: issuer, ledger_index: 'validated', signer_lists: true });
      const d = ai.account_data;
      const fl = Number(d.Flags || 0);
      row.domain = d.Domain ? hexToStr(d.Domain) : null;
      row.masterDisabled = (fl & LSF_DISABLE_MASTER) !== 0;
      row.regularKey = d.RegularKey || null;
      row.signerList = (d.signer_lists || []).length > 0;
      row.blackholed = row.masterDisabled && !row.signerList && !row.regularKey;
    } catch (e) { row.accountInfoError = String(e.message || e); }

    // score
    const s = await getJson(`${ORIGIN}/api/score/${encodeURIComponent(issuer)}`);
    if (s.status === 404) { row.xrplScore = null; row.notActivated = true; }
    else if (s.ok) {
      row.xrplScore = s.body.ledgerScore ?? null;
      row.grade = s.body.grade ?? null;
      row.percentile = s.body.percentile ?? null;
      row.accountAgeDays = s.body.details?.accountAgeDays ?? null;
      row.txCount = s.body.details?.txCount ?? null;
    } else row.xrplScoreError = `HTTP ${s.status}`;

    // credentials
    const cr = await getJson(`${ORIGIN}/api/credentials/account?address=${encodeURIComponent(issuer)}`);
    row.credentialsHeld = cr.ok ? (cr.body.count ?? 0) : `err ${cr.status}`;
    if (cr.ok && cr.body.count > 0) row.credentials = cr.body.credentials;

    row.bithompHolders = recon[issuer].holdersSum;
    row.bithompCount = recon[issuer].bithompCount;

    risk[issuer] = row;
    fs.writeFileSync(RISK_FILE, JSON.stringify(risk, null, 1));
    console.error(`  ${issuer}: mpts=${row.mpts} score=${row.xrplScore} age=${row.accountAgeDays} holders=${row.bithompHolders}`);
    await sleep(2500);
  }
  console.log(`Done. .mpt-issuer-risk.json now has ${Object.keys(risk).length} issuers.`);
}
main().catch(e => { console.error(e); process.exit(1); });

#!/usr/bin/env node
/* scripts/research-mpt-issuer-risk.cjs — RESEARCH ONLY.
 * The risk picture for every distinct MPT issuer found by the census walk.
 * XRPLScore + credentials from deployed xrplhub.io (Vercel IP, no local
 * rate limit); Flags/Domain via HTTPS JSON-RPC (separate rate bucket from
 * the wss:// endpoints the census hammered) with node rotation + retry.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const OUT_FILE = path.join(__dirname, '.mpt-issuer-risk.json');

const RPC_NODES = ['https://xrplcluster.com', 'https://s1.ripple.com:51234', 'https://s2.ripple.com:51234', 'https://xrpl.ws'];
const ORIGIN = 'https://www.xrplhub.io';
const LSF_DISABLE_MASTER = 0x00100000;
const LSF_NO_FREEZE = 0x00200000;
const LSF_GLOBAL_FREEZE = 0x00400000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function hexToStr(hex) {
  try { return Buffer.from(hex, 'hex').toString('utf8'); } catch { return hex; }
}

async function rpc(method, params, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const node = RPC_NODES[i % RPC_NODES.length];
    try {
      const res = await fetch(node, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, params: [params] }),
        signal: AbortSignal.timeout(20000),
      });
      const j = await res.json();
      if (j.result?.error === 'tooBusy' || j.result?.status === 'error') throw new Error(j.result?.error || 'rpc error');
      return j.result;
    } catch (e) {
      lastErr = e;
      await sleep(1500 * (i + 1));
    }
  }
  throw lastErr;
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

async function main() {
  const cp = require('./.mpt-census-checkpoint.json');
  const byIssuer = {};
  for (const r of Object.values(cp.issuances)) {
    const b = byIssuer[r.issuer] = byIssuer[r.issuer] || { count: 0, clawback: 0, canLock: 0, locked: 0, requireAuth: 0, noTransfer: 0, mpts: [] };
    b.count++;
    if (r.flags.canClawback) b.clawback++;
    if (r.flags.canLock) b.canLock++;
    if (r.flags.locked) b.locked++;
    if (r.flags.requireAuth) b.requireAuth++;
    if (!r.flags.canTransfer) b.noTransfer++;
    b.mpts.push({ id: r.id, meta: r.metadataHex ? hexToStr(r.metadataHex) : null });
  }
  const issuers = Object.keys(byIssuer).sort((a, b) => byIssuer[b].count - byIssuer[a].count);
  console.error(`${issuers.length} distinct MPT issuers (census walk was ~2/3 complete when stopped — this is a FLOOR).`);

  let done = {};
  try { done = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); } catch {}

  if (process.argv.includes('--report')) { printReport(byIssuer, issuers, done); return; }

  const rows = [];
  for (const issuer of issuers) {
    if (done[issuer]) { rows.push(done[issuer]); continue; }
    const f = byIssuer[issuer];
    const row = { issuer, mpts: f.count, mptMeta: f.mpts, flags: f };

    try {
      const ai = await rpc('account_info', { account: issuer, ledger_index: 'validated', signer_lists: true });
      const d = ai.account_data;
      const flags = Number(d.Flags || 0);
      row.domain = d.Domain ? hexToStr(d.Domain) : null;
      row.masterDisabled = (flags & LSF_DISABLE_MASTER) !== 0;
      row.globalFreeze = (flags & LSF_GLOBAL_FREEZE) !== 0;
      row.noFreezeSet = (flags & LSF_NO_FREEZE) !== 0;
      row.regularKey = d.RegularKey || null;
      row.signerList = (d.signer_lists || []).length > 0;
      row.blackholed = row.masterDisabled && !row.signerList && !row.regularKey;
    } catch (e) { row.accountInfoError = String(e.message || e); }

    const s = await getJson(`${ORIGIN}/api/score/${encodeURIComponent(issuer)}`);
    if (s.status === 404) { row.xrplScore = null; row.notActivated = true; }
    else if (s.ok) {
      row.xrplScore = s.body.ledgerScore ?? null;
      row.grade = s.body.grade ?? null;
      row.percentile = s.body.percentile ?? null;
      row.accountAgeDays = s.body.details?.accountAgeDays ?? null;
      row.txCount = s.body.details?.txCount ?? null;
      row.hasRegKey = s.body.details?.hasRegKey ?? null;
      row.hasMultiSig = s.body.details?.hasMultiSig ?? null;
    } else row.xrplScoreError = `HTTP ${s.status}`;

    const cr = await getJson(`${ORIGIN}/api/credentials/account?address=${encodeURIComponent(issuer)}`);
    row.credentialsHeld = cr.ok ? (cr.body.count ?? 0) : `err ${cr.status}`;
    if (cr.ok && cr.body.count > 0) row.credentials = cr.body.credentials;

    rows.push(row);
    done[issuer] = row;
    fs.writeFileSync(OUT_FILE, JSON.stringify(done, null, 1));
    console.error(`  done: ${issuer} score=${row.xrplScore} age=${row.accountAgeDays} blackholed=${row.blackholed}`);
    await sleep(1500);
  }

  printReport(byIssuer, issuers, done);
}

function printReport(byIssuer, issuers, done) {
  console.log('\n=== ISSUER RISK TABLE (' + Object.keys(done).length + '/' + issuers.length + ' gathered) ===');
  const H = ['issuer', 'MPTs', 'score', 'grade', 'age(d)', 'blackholed', 'domain', 'creds', 'clawback', 'canLock', 'locked', 'reqAuth', 'no-transfer'];
  console.log(H.join(' | '));
  for (const issuer of issuers) {
    const r = done[issuer];
    const f = byIssuer[issuer];
    if (!r) { console.log([issuer, f.count, '(pending)', '', '', '', '', '', `${f.clawback}/${f.count}`, `${f.canLock}/${f.count}`, `${f.locked}/${f.count}`, `${f.requireAuth}/${f.count}`, `${f.noTransfer}/${f.count}`].join(' | ')); continue; }
    console.log([
      r.issuer, r.mpts,
      r.notActivated ? 'n/a' : (r.xrplScore ?? '?'),
      r.grade ?? '-',
      r.accountAgeDays ?? '?',
      r.blackholed ? 'YES' : (r.masterDisabled ? 'master-off' : 'no'),
      (r.domain || '-').slice(0, 28),
      r.credentialsHeld,
      `${r.flags.clawback}/${r.mpts}`,
      `${r.flags.canLock}/${r.mpts}`,
      `${r.flags.locked}/${r.mpts}`,
      `${r.flags.requireAuth}/${r.mpts}`,
      `${r.flags.noTransfer}/${r.mpts}`,
    ].join(' | '));
  }
}

main().catch(e => { console.error(e); process.exit(1); });

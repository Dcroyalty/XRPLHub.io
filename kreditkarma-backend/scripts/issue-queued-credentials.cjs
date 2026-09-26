#!/usr/bin/env node
/* scripts/issue-queued-credentials.cjs
 *
 * Operator tool for "we issue, they accept". Lists the credential requests wallets have queued (POST /api/credentials/request) and,
 * only with --issue, issues each one by running the reviewed single-credential tool (scripts/issue-credential.cjs issue <subject>),
 * which re-scores the wallet at that moment, refuses if the tier changed, signs from CREDENTIAL_ISSUER_SEED and submits to mainnet.
 * The issuer seed never leaves this machine; the deployed app has no access to it.
 *
 *   node scripts/issue-queued-credentials.cjs                 # list what is queued (default; changes nothing)
 *   node scripts/issue-queued-credentials.cjs --issue         # issue every queued request, oldest first
 *   node scripts/issue-queued-credentials.cjs --issue --max 5 # at most 5 this run
 *   node scripts/issue-queued-credentials.cjs --decline <requestId> "reason"
 *
 * Reads DATABASE_URL and CREDENTIAL_ISSUER_SEED from .env (PRODUCTION values). Each issuance costs the issuer a 0.2 XRP owner reserve
 * until the subject accepts (docs/CREDENTIAL-SPEC.md §6) — the list prints the running reserve so you can see it before you say --issue.
 */
require('dotenv').config();
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

(async () => {
  if (has('--decline')) {
    const id = val('--decline');
    const reason = args[args.indexOf('--decline') + 2] || 'declined by operator';
    if (!id) throw new Error('usage: --decline <requestId> "reason"');
    const r = await prisma.credentialRequest.update({ where: { id }, data: { status: 'declined', note: reason } });
    console.log('declined', r.id, r.subject);
    return;
  }

  const max = Number(val('--max') || 50);
  const queued = await prisma.credentialRequest.findMany({ where: { status: 'queued' }, orderBy: { requestedAt: 'asc' }, take: max });
  console.log(`${queued.length} queued request(s):`);
  for (const q of queued) console.log(`  ${q.id}  ${q.subject}  ${q.tier}  score@request=${q.scoreAtRequest}  ${q.requestedAt.toISOString()}`);
  console.log(`issuing all of them would tie up ${(queued.length * 0.2).toFixed(1)} XRP of issuer reserve until the subjects accept.`);
  if (!has('--issue')) { console.log('\n(list only — add --issue to issue them)'); return; }

  for (const q of queued) {
    console.log(`\n=== issuing ${q.id} → ${q.subject} (${q.tier}) ===`);
    try {
      const out = execFileSync(process.execPath, [path.join(__dirname, 'issue-credential.cjs'), 'issue', q.subject], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      process.stdout.write(out);
      const hash = (/tx hash\s+([0-9A-F]{64})/i.exec(out) || [])[1];
      const engine = (/engine result\s+(\S+)/.exec(out) || [])[1];
      if (hash && engine === 'tesSUCCESS') {
        await prisma.credentialRequest.update({ where: { id: q.id }, data: { status: 'issued', issuedAt: new Date(), issuedTxHash: hash } });
        console.log('recorded as issued');
      } else {
        await prisma.credentialRequest.update({ where: { id: q.id }, data: { status: 'failed', note: `engine result ${engine || 'unknown'}` } });
        console.log('NOT issued (engine result', engine || 'unknown', ') — marked failed');
      }
    } catch (e) {
      const msg = String((e && (e.stderr || e.stdout || e.message)) || e).slice(0, 400);
      console.log('NOT issued:', msg);
      // A tier change / ineligibility is a normal refusal, not a system fault: mark it so the queue does not retry forever.
      await prisma.credentialRequest.update({ where: { id: q.id }, data: { status: 'failed', note: msg } });
    }
  }
})()
  .catch((e) => { console.error('ERROR:', e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());

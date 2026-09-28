#!/usr/bin/env node
/* scripts/backup-screening-receipts.mjs
 *
 * Manual/local runner for src/lib/screenBackup.ts — the off-Neon durability backup for the 10-year screening-receipt
 * retention promise. The daily cron (06:00 UTC) runs this automatically once GITHUB_TOKEN is set in Vercel; run this
 * by hand to seed the backup immediately, to backfill a large backlog beyond the cron's per-run cap, or to check
 * status without waiting for the schedule.
 *
 *   node scripts/backup-screening-receipts.mjs              # process up to 5 days (same cap as the cron), report
 *   node scripts/backup-screening-receipts.mjs --all         # keep going until every day up to yesterday is backed up
 *
 * Reads DATABASE_URL from .env (production!) and GITHUB_TOKEN. GITHUB_TOKEN must be a FINE-GRAINED PAT scoped to
 * ONLY the private backup repo (Dcroyalty/xrplhub-screening-backups), Contents: Read and write, and nothing else —
 * never a classic repo-scope PAT (those can push to every repo you own, including the public app repo). Writes to
 * backups/screening-receipts/<date>.jsonl in GITHUB_BACKUP_REPO (default Dcroyalty/xrplhub-screening-backups, a
 * PRIVATE repo — a screening receipt contains subjectAddress and a customer's API key prefix, so this must never
 * point at a public repo) via the GitHub Contents API — no XRPL key, no signing, ever.
 */
import 'dotenv/config';
import './ts-hooks.mjs';
import { createRequire } from 'node:module';

const REPO_ROOT = new URL('../', import.meta.url);
const require = createRequire(new URL('package.json', REPO_ROOT));
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { runScreeningBackup } = await import(new URL('src/lib/screenBackup.ts', REPO_ROOT).href);

const all = process.argv.includes('--all');

(async () => {
  if (!process.env.GITHUB_TOKEN) {
    console.error('GITHUB_TOKEN is not set. Set it to a FINE-GRAINED GitHub PAT scoped ONLY to ' + (process.env.GITHUB_BACKUP_REPO || 'Dcroyalty/xrplhub-screening-backups') + ' (Contents: Read and write) — never a classic repo-scope PAT.');
    process.exitCode = 1;
    return;
  }
  let totalDays = 0, totalReceipts = 0;
  for (;;) {
    const r = await runScreeningBackup(prisma, { deadlineMs: Date.now() + 45_000 });
    if (!r.ran) { console.log('not run:', r.reason); break; }
    console.log(JSON.stringify(r, null, 2));
    totalDays += r.daysProcessed.length;
    totalReceipts += r.receiptsBackedUp;
    if (r.daysFailed.length) { console.error('stopped on a failure — fix and re-run (idempotent, safe to repeat).'); process.exitCode = 1; break; }
    if (!all || r.daysProcessed.length === 0) break; // nothing left to do, or single-run mode
  }
  console.log(`\ndone — ${totalDays} day(s), ${totalReceipts} receipt(s) backed up this run.`);
})().finally(() => prisma.$disconnect());

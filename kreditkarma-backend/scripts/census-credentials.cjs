#!/usr/bin/env node
/* scripts/census-credentials.cjs
 *
 * Hand-run XRPL Credential census. Walks ledger_data (type: "credential")
 * across the WHOLE mainnet state tree and writes into the same
 * IndexedCredential / IndexerCheckpoint tables the deployed cron route
 * (src/app/api/cron/index-credentials, src/lib/credentialIndexer.ts) uses —
 * run this to get to a first complete pass fast instead of waiting on
 * Vercel's once-daily Hobby-plan cron to grind through it a bounded chunk
 * at a time.
 *
 * Deliberately standalone (same convention as issue-credential.cjs): mirrors
 * the deployed indexer's logic rather than importing it, so there's no
 * runtime dependency from a hand-run script into the Next.js build.
 *
 *   node scripts/census-credentials.cjs           # run to a complete pass
 *   node scripts/census-credentials.cjs --once     # do one page and stop
 *   node scripts/census-credentials.cjs --status   # print checkpoint, no walking
 */
require('dotenv').config();
const { Client } = require('xrpl');
const { PrismaClient } = require('@prisma/client');

const MAINNET_ENDPOINTS = ['wss://xrplcluster.com', 'wss://s1.ripple.com', 'wss://s2.ripple.com'];
const MAINNET_NETWORK_ID = 0;
const CHECKPOINT_ID = 'credential';
const PAGE_LIMIT = 200;

async function connectMainnetOrThrow() {
  let lastErr;
  for (const wss of MAINNET_ENDPOINTS) {
    const client = new Client(wss);
    try {
      await client.connect();
      if (client.networkID !== undefined && client.networkID !== MAINNET_NETWORK_ID) {
        throw new Error(`REFUSING: ${wss} networkID=${client.networkID}, expected mainnet (0).`);
      }
      const info = await client.request({ command: 'server_info' });
      const netId = info.result?.info?.network_id;
      if (netId !== MAINNET_NETWORK_ID) {
        throw new Error(`REFUSING: ${wss} server_info network_id=${netId}, expected mainnet (0).`);
      }
      return client;
    } catch (err) {
      await client.disconnect().catch(() => {});
      lastErr = err;
    }
  }
  throw lastErr || new Error('Could not reach an XRPL mainnet node.');
}

async function main() {
  const args = process.argv.slice(2);
  const prisma = new PrismaClient();

  if (args.includes('--status')) {
    const cp = await prisma.indexerCheckpoint.findUnique({ where: { id: CHECKPOINT_ID } });
    const total = await prisma.indexedCredential.count();
    console.log(JSON.stringify({ checkpoint: cp, indexedCredentials: total }, null, 2));
    await prisma.$disconnect();
    return;
  }

  const once = args.includes('--once');
  const client = await connectMainnetOrThrow();
  console.log('Connected to mainnet.');

  try {
    let pass = 0;
    for (;;) {
      let checkpoint = await prisma.indexerCheckpoint.findUnique({ where: { id: CHECKPOINT_ID } });
      if (!checkpoint) checkpoint = await prisma.indexerCheckpoint.create({ data: { id: CHECKPOINT_ID } });

      const isNewPass = checkpoint.status === 'idle';
      const passNumber = isNewPass ? checkpoint.passNumber + 1 : checkpoint.passNumber;
      let marker = isNewPass ? null : checkpoint.marker;

      if (isNewPass) {
        console.log(`Starting pass ${passNumber}...`);
        await prisma.indexerCheckpoint.update({
          where: { id: CHECKPOINT_ID },
          data: { status: 'running', passNumber, passStartedAt: new Date(), marker: null },
        });
      }

      const ledgerRes = await client.request({ command: 'ledger', ledger_index: 'validated' });
      const nowRipple = ledgerRes.result?.ledger?.close_time;
      if (typeof nowRipple !== 'number') throw new Error('No close_time on validated ledger.');

      const res = await client.request({
        command: 'ledger_data',
        ledger_index: 'validated',
        type: 'credential',
        limit: PAGE_LIMIT,
        ...(marker ? { marker } : {}),
      });
      const state = res.result.state || [];
      let seen = 0;
      for (const node of state) {
        if (node.LedgerEntryType !== 'Credential') continue;
        const flags = Number(node.Flags || 0);
        const data = {
          issuer: String(node.Issuer || ''),
          subject: String(node.Subject || ''),
          credentialType: String(node.CredentialType || ''),
          accepted: (flags & 0x00010000) !== 0,
          expirationRipple: typeof node.Expiration === 'number' ? node.Expiration : null,
          uri: typeof node.URI === 'string' ? node.URI : null,
          passNumber,
        };
        await prisma.indexedCredential.upsert({
          where: { objectIndex: String(node.index || '') },
          create: { objectIndex: String(node.index || ''), ...data },
          update: data,
        });
        seen++;
      }
      pass++;
      process.stdout.write(`  page ${pass}: +${seen} credentials seen, marker=${res.result.marker ? 'more' : 'END'}\n`);

      marker = res.result.marker || null;
      if (!marker) {
        await prisma.indexedCredential.deleteMany({ where: { passNumber: { lt: passNumber } } });
        const completedAt = new Date();
        await prisma.indexerCheckpoint.update({
          where: { id: CHECKPOINT_ID },
          data: {
            status: 'idle', marker: null,
            lastCompletedPassAt: completedAt, lastCompletedPassNumber: passNumber,
            lastLedgerCloseTime: nowRipple,
          },
        });
        const total = await prisma.indexedCredential.count();
        console.log(`\nPass ${passNumber} complete at ${completedAt.toISOString()}. ${total} credentials indexed network-wide.`);
        break;
      }
      await prisma.indexerCheckpoint.update({
        where: { id: CHECKPOINT_ID },
        data: { marker, lastLedgerCloseTime: nowRipple },
      });
      if (once) {
        console.log('--once: stopping after one page. Re-run to continue this pass.');
        break;
      }
    }
  } finally {
    await client.disconnect().catch(() => {});
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

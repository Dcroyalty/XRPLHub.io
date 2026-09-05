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
 * A full pass over the whole ledger keyspace is thousands of pages even
 * though Credential objects are a sparse handful of them — a single
 * transient RPC timeout is near-certain somewhere in that many round trips.
 * Each request retries with backoff before giving up on it, and losing the
 * connection entirely triggers a reconnect + resume (from the persisted
 * marker, not a restart) rather than crashing the whole walk. Only gives up
 * for good after several consecutive full-page failures in a row.
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
const MAX_CONSECUTIVE_PAGE_FAILURES = 8;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectMainnetOrThrow(endpointOffset = 0) {
  let lastErr;
  const endpoints = [...MAINNET_ENDPOINTS.slice(endpointOffset), ...MAINNET_ENDPOINTS.slice(0, endpointOffset)];
  for (const wss of endpoints) {
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
      console.log(`Connected to ${wss} (mainnet confirmed).`);
      return client;
    } catch (err) {
      await client.disconnect().catch(() => {});
      lastErr = err;
    }
  }
  throw lastErr || new Error('Could not reach an XRPL mainnet node.');
}

/** Retry one request a few times with backoff before giving up on it. */
async function requestWithRetry(client, req, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await client.request(req);
    } catch (err) {
      lastErr = err;
      if (isMarkerError(err)) break; // not transient — retrying can never succeed, fail fast
      if (i < attempts - 1) {
        const delay = 1000 * Math.pow(2, i); // 1s, 2s, 4s
        console.warn(`  request ${req.command} failed (attempt ${i + 1}/${attempts}): ${err.message || err} — retrying in ${delay}ms`);
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

function isMarkerError(err) {
  const msg = String(err && (err.message || err.data?.error || err));
  return /markerMalformed|invalid.*marker/i.test(msg);
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
  let client = await connectMainnetOrThrow();
  let endpointOffset = 0;
  let consecutiveFailures = 0;
  let forceRestartMarker = false;

  try {
    let pageCount = 0;
    for (;;) {
      let checkpoint = await prisma.indexerCheckpoint.findUnique({ where: { id: CHECKPOINT_ID } });
      if (!checkpoint) checkpoint = await prisma.indexerCheckpoint.create({ data: { id: CHECKPOINT_ID } });

      const isNewPass = checkpoint.status === 'idle';
      const passNumber = isNewPass ? checkpoint.passNumber + 1 : checkpoint.passNumber;
      const marker = isNewPass || forceRestartMarker ? null : checkpoint.marker;
      forceRestartMarker = false;

      if (isNewPass) {
        console.log(`Starting pass ${passNumber}...`);
        await prisma.indexerCheckpoint.update({
          where: { id: CHECKPOINT_ID },
          data: { status: 'running', passNumber, passStartedAt: new Date(), marker: null },
        });
      }

      let nowRipple, res;
      try {
        const ledgerRes = await requestWithRetry(client, { command: 'ledger', ledger_index: 'validated' });
        nowRipple = ledgerRes.result?.ledger?.close_time;
        if (typeof nowRipple !== 'number') throw new Error('No close_time on validated ledger.');

        res = await requestWithRetry(client, {
          command: 'ledger_data',
          ledger_index: 'validated',
          type: 'credential',
          limit: PAGE_LIMIT,
          ...(marker ? { marker } : {}),
        });
        consecutiveFailures = 0;
      } catch (err) {
        // ledger_data markers are tied to the specific backend node that
        // issued them - xrplcluster.com is a load-balanced cluster, so a
        // reconnect can land on a different node that rejects the old
        // marker outright. That's not transient; retrying it can never
        // succeed. The only fix is to restart THIS pass from the beginning
        // (marker=null) - rows already collected this pass stay valid and
        // get re-confirmed, nothing is lost, but the walk starts over.
        if (isMarkerError(err)) {
          console.warn(`Marker rejected by the server (node handoff) — restarting pass ${passNumber} from the beginning. Already-collected rows are kept.`);
          forceRestartMarker = true;
          consecutiveFailures = 0;
          continue;
        }
        consecutiveFailures++;
        console.error(`Page failed after retries (${consecutiveFailures}/${MAX_CONSECUTIVE_PAGE_FAILURES} consecutive): ${err.message || err}`);
        if (consecutiveFailures >= MAX_CONSECUTIVE_PAGE_FAILURES) {
          throw new Error(`Giving up after ${MAX_CONSECUTIVE_PAGE_FAILURES} consecutive page failures. Checkpoint is saved — re-run to resume from marker.`);
        }
        // Reconnect (try the next endpoint in rotation) and retry this same page.
        await client.disconnect().catch(() => {});
        endpointOffset = (endpointOffset + 1) % MAINNET_ENDPOINTS.length;
        await sleep(2000);
        client = await connectMainnetOrThrow(endpointOffset);
        continue;
      }

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
      pageCount++;
      if (pageCount % 25 === 0 || seen > 0) {
        process.stdout.write(`  page ${pageCount}: +${seen} credentials seen, marker=${res.result.marker ? 'more' : 'END'}\n`);
      }

      const nextMarker = res.result.marker || null;
      if (!nextMarker) {
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
        data: { marker: nextMarker, lastLedgerCloseTime: nowRipple },
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

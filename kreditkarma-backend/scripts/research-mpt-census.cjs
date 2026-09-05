#!/usr/bin/env node
/* scripts/research-mpt-census.cjs
 *
 * RESEARCH ONLY — not part of the product yet. Answers "how many
 * MPTokenIssuance objects exist on mainnet right now, and who issued them"
 * by walking ledger_data (type: "mpt_issuance", confirmed short name from
 * xrpl.org's ledger-entry-short-names reference — same mechanism as
 * type:"credential", per XLS-33).
 *
 * Same resilience pattern as scripts/census-credentials.cjs (built and
 * battle-tested this session): retry-with-backoff on transient failures,
 * fail-fast + restart-the-pass on markerMalformed (ledger_data markers are
 * tied to the specific backend node that issued them — xrplcluster.com is a
 * load-balanced cluster, so a reconnect can land on a different node that
 * rejects the old marker; retrying it can never succeed).
 *
 * Deliberately NOT writing into the product's Postgres/Prisma schema — this
 * is a research question, not a shipped feature. Checkpoint + results live
 * in a local JSON file next to this script.
 *
 *   node scripts/research-mpt-census.cjs           # run to a complete pass
 *   node scripts/research-mpt-census.cjs --status   # print progress, no walking
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('xrpl');

const MAINNET_ENDPOINTS = ['wss://xrplcluster.com', 'wss://s1.ripple.com', 'wss://s2.ripple.com'];
const MAINNET_NETWORK_ID = 0;
const PAGE_LIMIT = 200;
const MAX_CONSECUTIVE_PAGE_FAILURES = 8;
const CHECKPOINT_FILE = path.join(__dirname, '.mpt-census-checkpoint.json');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMarkerError(err) {
  const msg = String(err && (err.message || err.data?.error || err));
  return /markerMalformed|invalid.*marker/i.test(msg);
}

function loadCheckpoint() {
  try {
    return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
  } catch {
    return { status: 'idle', marker: null, passNumber: 0, issuances: {}, completedAt: null };
  }
}

function saveCheckpoint(cp) {
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp, null, 2));
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

async function requestWithRetry(client, req, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await client.request(req);
    } catch (err) {
      lastErr = err;
      if (isMarkerError(err)) break;
      if (i < attempts - 1) {
        const delay = 1000 * Math.pow(2, i);
        console.warn(`  request ${req.command} failed (attempt ${i + 1}/${attempts}): ${err.message || err} — retrying in ${delay}ms`);
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

function summarize(cp) {
  const issuers = {};
  for (const rec of Object.values(cp.issuances)) {
    issuers[rec.issuer] = (issuers[rec.issuer] || 0) + 1;
  }
  return {
    totalIssuances: Object.keys(cp.issuances).length,
    distinctIssuers: Object.keys(issuers).length,
    byIssuer: Object.entries(issuers).sort((a, b) => b[1] - a[1]),
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--status')) {
    const cp = loadCheckpoint();
    console.log(JSON.stringify({ status: cp.status, passNumber: cp.passNumber, completedAt: cp.completedAt, ...summarize(cp) }, null, 2));
    return;
  }

  let client = await connectMainnetOrThrow();
  let endpointOffset = 0;
  let consecutiveFailures = 0;

  try {
    let pageCount = 0;
    for (;;) {
      let cp = loadCheckpoint();
      const isNewPass = cp.status === 'idle';
      const passNumber = isNewPass ? cp.passNumber + 1 : cp.passNumber;
      let marker = isNewPass ? null : cp.marker;
      if (isNewPass) {
        console.log(`Starting pass ${passNumber}...`);
        cp = { ...cp, status: 'running', passNumber, marker: null };
        saveCheckpoint(cp);
      }

      let res;
      try {
        res = await requestWithRetry(client, {
          command: 'ledger_data',
          ledger_index: 'validated',
          type: 'mpt_issuance',
          limit: PAGE_LIMIT,
          ...(marker ? { marker } : {}),
        });
        consecutiveFailures = 0;
      } catch (err) {
        if (isMarkerError(err)) {
          console.warn(`Marker rejected by the server (node handoff) — restarting pass ${passNumber} from the beginning. Already-collected issuances are kept.`);
          cp = loadCheckpoint();
          cp.marker = null;
          saveCheckpoint(cp);
          continue;
        }
        consecutiveFailures++;
        console.error(`Page failed after retries (${consecutiveFailures}/${MAX_CONSECUTIVE_PAGE_FAILURES}): ${err.message || err}`);
        if (consecutiveFailures >= MAX_CONSECUTIVE_PAGE_FAILURES) {
          throw new Error(`Giving up after ${MAX_CONSECUTIVE_PAGE_FAILURES} consecutive page failures. Checkpoint saved — re-run to resume.`);
        }
        await client.disconnect().catch(() => {});
        endpointOffset = (endpointOffset + 1) % MAINNET_ENDPOINTS.length;
        await sleep(2000);
        client = await connectMainnetOrThrow(endpointOffset);
        continue;
      }

      const state = res.result.state || [];
      let seen = 0;
      cp = loadCheckpoint();
      for (const node of state) {
        if (node.LedgerEntryType !== 'MPTokenIssuance') continue;
        const flags = Number(node.Flags || 0);
        cp.issuances[String(node.index || '')] = {
          issuer: String(node.Issuer || ''),
          sequence: node.Sequence,
          assetScale: node.AssetScale,
          maximumAmount: node.MaximumAmount || null,
          outstandingAmount: node.OutstandingAmount || '0',
          transferFee: node.TransferFee || 0,
          metadataHex: node.MPTokenMetadata || null,
          flags: {
            raw: flags,
            locked: !!(flags & 0x00000001),
            canLock: !!(flags & 0x00000002),
            requireAuth: !!(flags & 0x00000004),
            canEscrow: !!(flags & 0x00000008),
            canTrade: !!(flags & 0x00000010),
            canTransfer: !!(flags & 0x00000020),
            canClawback: !!(flags & 0x00000040),
          },
        };
        seen++;
      }
      pageCount++;
      cp.marker = res.result.marker || null;
      saveCheckpoint(cp);
      if (pageCount % 25 === 0 || seen > 0) {
        console.log(`  page ${pageCount}: +${seen} MPTokenIssuance objects seen, marker=${cp.marker ? 'more' : 'END'}`);
      }

      if (!cp.marker) {
        cp.status = 'idle';
        cp.completedAt = new Date().toISOString();
        saveCheckpoint(cp);
        const summary = summarize(cp);
        console.log(`\nPass ${passNumber} complete at ${cp.completedAt}.`);
        console.log(`Total MPTokenIssuance objects: ${summary.totalIssuances}`);
        console.log(`Distinct issuers: ${summary.distinctIssuers}`);
        console.log('By issuer:');
        for (const [issuer, count] of summary.byIssuer) console.log(`  ${issuer}: ${count}`);
        break;
      }
    }
  } finally {
    await client.disconnect().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

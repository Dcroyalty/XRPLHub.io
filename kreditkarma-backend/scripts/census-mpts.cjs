#!/usr/bin/env node
/* scripts/census-mpts.cjs
 *
 * The MPTokenIssuance registry census — hand-run counterpart to the bounded
 * cron in src/lib/mptIndexer.ts. Writes the same tables (IndexedMPT,
 * IndexedMptIssuer, IndexerCheckpoint id="mpt") so a human can seed the index
 * and run either source to completion without waiting on the daily cron.
 *
 *   node scripts/census-mpts.cjs --status      # progress, no work
 *   node scripts/census-mpts.cjs --seed        # one-time: load the local
 *                                              #   research JSON into IndexedMptIssuer
 *   node scripts/census-mpts.cjs --bithomp     # full Bithomp per-issuer pull
 *                                              #   for every known issuer (paced)
 *   node scripts/census-mpts.cjs               # the ledger_data walk, resumable,
 *                                              #   run to a complete pass
 *   node scripts/census-mpts.cjs --once        # ...one page then stop
 *
 * Resilience matches scripts/census-credentials.cjs: retry-with-backoff on
 * transient RPC failures, and on markerMalformed (ledger_data markers are
 * tied to the backend node that issued them — a reconnect can land on a
 * different node that rejects the old marker) the CURRENT pass restarts from
 * the beginning; rows already collected keep their passNumber and get
 * re-confirmed, nothing is lost.
 */
require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const { Client, decodeAccountID, convertHexToString } = require('xrpl');
const { PrismaClient } = require('@prisma/client');

const MAINNET_ENDPOINTS = ['wss://xrplcluster.com', 'wss://s1.ripple.com', 'wss://s2.ripple.com'];
const MAINNET_NETWORK_ID = 0;
const CHECKPOINT_ID = 'mpt';
const PAGE_LIMIT = 200;
const MAX_CONSECUTIVE_PAGE_FAILURES = 8;
const BITHOMP_BASE = 'https://bithomp.com/api/v2';
const BITHOMP_KEY = (process.env.BITHOMP_API_KEY || '').replace(/[<>]/g, '');

const BOOTSTRAP_ISSUERS = [
  'rM7ffj9GZV41K8fWUhtpfZSZvYoZB2yA4t', 'rPm6K1fr4MNcv5W8pD4RCawVHjsK1ziCKp',
  'rLKfWwLeimLe69mrTr3MygNavDxL8tjuUX', 'rinAXYBnAf1xeSZGaZ28EVQVQvxYj2Wex',
  'rMi1UL1joGAn3rH6Cu9GDiTeErFx8Pc33H', 'rsiPEXNs1XGn14DV7MHXsTfQVpGiEpJ347',
  'r9ASYAPBCyzW5zEy5H4e66t2oigUdZN14p', 'rULZPkxia4xpYtb9rEJUsHenmWAMZfwAzp',
  'rGJdc5PUa5dGE6BiDcufXyU9BDSQ4Zg2r8', 'r3hcwikU3XyAXX9969oRzDJm7B5hepfXGe',
  'rBJ2ogWEZvsxkuK7aV4k6H9VAto7k2SsH9', 'rHCx2zWMN1r9yB78mtNX9bUUHCL5eMYHUR',
  'raFWVyTwpks1hd2rEbi85AtPPnJ3DuwrA9', 'rGxUbYEHnmiJ55e5hKuJ9m7dthdJHSx5vz',
  'rPgswA5wCM6wvtzsNd7oQa6r3UK5YT6om9', 'r9o37ZXw3VQyvZzYk4p6wEgGZhH14mHmr2',
  'r4WkNmYkB1M5hcZF3vYLfiLseJfKvgkFyA', 'rKSg2VZbw9gRRuSwBjBFAfBoGC5Vs1FmFn',
  'rEkGNmAo4R7KfA6wZre62LJXDUvmtgg66i', 'rJyNbUbcvP19KYwMq2bPnvYQNwUY2ZQrWZ',
  'rJnCt4Mm826qSA6jc4WqwmrpwPxBBgLfwp', 'rswtXJQkf1kMzrZn1xho1KrkfcsCa2nNAv',
  'rNyrL3hjvM3mDYtTDhHLWMiGtbnV2wdBv6', 'rfXMq3BMX2dTzJtG4pnhr49u6sHkVQXpWL',
  'r9avT7NURuqC7jbVxUjcrMkHAr5aqmHkSN', 'rMzydKJUk5tUq3ZuVQGNaRJMh9TQ624PML',
  'r3iMKCiKqu522oRGQcAdyvwoRUaTn7s8fi', 'rLm3recAhoqwfnU4HF2RybjALBXVvhJ2Ku',
  'rwA8orrVtNPuBykRvQdDJzRDQbe7CuxCiR', 'rUxiSsPXBhBRznVarw3Vu1Rss8FhHEnDg',
  'rs2uGjFkNAdLJgoLytQVXrqwbwjLoU3BT6', 'rK5pfemxwpe2ioXKSdqnQaYCZ6NeKkgouv',
  'rtsTmBYcMGoNuPV6TBGU9gMhzn5vsVNsa', 'rLr3ZxWy7owtSwaCH2n7tCauQENrt9MVgU',
];

const FLAG = { locked: 1, canLock: 2, requireAuth: 4, canEscrow: 8, canTrade: 16, canTransfer: 32, canClawback: 64 };

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function isMarkerError(err) {
  const msg = String(err && (err.message || err.data?.error || err));
  return /markerMalformed|invalid.*marker/i.test(msg);
}
function safeDecode(hex) { try { return convertHexToString(hex); } catch { return hex; } }
function deriveIssuanceId(sequence, issuer) {
  const seqHex = (sequence >>> 0).toString(16).toUpperCase().padStart(8, '0');
  const acctHex = Buffer.from(decodeAccountID(issuer)).toString('hex').toUpperCase();
  return seqHex + acctHex;
}
function nameFromMeta(metaStr) {
  if (!metaStr) return null;
  try {
    const o = JSON.parse(metaStr);
    const n = o.name ?? o.ticker ?? o.currency ?? o.n ?? o.t;
    return typeof n === 'string' && n.trim() ? n.trim() : null;
  } catch { return null; }
}
function idsHash(ids) {
  return crypto.createHash('sha256').update([...ids].sort().join(',')).digest('hex');
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
      if (info.result?.info?.network_id !== MAINNET_NETWORK_ID) {
        throw new Error(`REFUSING: ${wss} server_info network_id mismatch.`);
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
    try { return await client.request(req); }
    catch (err) {
      lastErr = err;
      if (isMarkerError(err)) break;
      if (i < attempts - 1) {
        const delay = 1000 * 2 ** i;
        console.warn(`  ${req.command} failed (${i + 1}/${attempts}): ${err.message || err} — retry ${delay}ms`);
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

async function upsertRow(prisma, row, passNumber) {
  if (!/^[0-9A-F]{48}$/.test(row.issuanceId) || !row.issuer) return false;
  const existing = await prisma.indexedMPT.findUnique({ where: { issuanceId: row.issuanceId }, select: { sources: true } });
  const sources = new Set((existing?.sources ?? '').split(',').filter(Boolean));
  sources.add(row.source);
  const common = {
    issuer: row.issuer, sequence: row.sequence, assetScale: row.assetScale,
    maxAmount: row.maxAmount, outstanding: row.outstanding, transferFee: row.transferFee,
    flagsRaw: row.flagsRaw, metadata: row.metadata, name: row.name,
    nameLower: row.name ? row.name.toLowerCase() : null,
    sources: [...sources].sort().join(','),
  };
  if (row.holderCount != null) common.holderCount = row.holderCount;
  if (row.source === 'walk') { common.passNumber = passNumber; common.ledgerIndex = row.ledgerIndex ?? null; }
  await prisma.indexedMPT.upsert({
    where: { issuanceId: row.issuanceId },
    create: { issuanceId: row.issuanceId, ...common },
    update: common,
  });
  return true;
}

async function refreshAggregate(prisma, issuer) {
  const rows = await prisma.indexedMPT.findMany({ where: { issuer }, select: { issuanceId: true } });
  const hash = idsHash(rows.map((r) => r.issuanceId));
  await prisma.indexedMptIssuer.upsert({
    where: { issuer },
    create: { issuer, mptCount: rows.length, issuanceIdsHash: hash },
    update: { mptCount: rows.length, issuanceIdsHash: hash },
  });
  return rows.length;
}

// ── modes ────────────────────────────────────────────────────────────────────

async function doStatus(prisma) {
  const cp = await prisma.indexerCheckpoint.findUnique({ where: { id: CHECKPOINT_ID } });
  const total = await prisma.indexedMPT.count();
  const issuers = await prisma.indexedMPT.findMany({ select: { issuer: true }, distinct: ['issuer'] });
  const bySource = await prisma.indexedMPT.groupBy({ by: ['sources'], _count: true });
  console.log(JSON.stringify({
    checkpoint: cp,
    coverage: cp?.lastCompletedPassAt ? 'complete' : 'partial',
    indexedIssuances: total,
    indexedIssuers: issuers.length,
    bySource,
  }, null, 2));
}

async function doSeed(prisma) {
  // Seed IndexedMptIssuer from the local research JSON (score + domain + blackhole).
  let risk = {};
  try { risk = require('./.mpt-issuer-risk.json'); } catch { console.warn('no .mpt-issuer-risk.json — seeding score-less'); }
  const issuers = new Set([...BOOTSTRAP_ISSUERS, ...Object.keys(risk)]);
  for (const issuer of issuers) {
    const r = risk[issuer] || {};
    await prisma.indexedMptIssuer.upsert({
      where: { issuer },
      create: {
        issuer, mptCount: 0,
        xrplScore: typeof r.xrplScore === 'number' ? r.xrplScore : null,
        grade: r.grade ?? null, domain: r.domain ?? null,
        blackholed: !!r.blackholed,
        scoredAt: r.xrplScore != null ? new Date() : null,
      },
      update: {},
    });
  }
  console.log(`Seeded ${issuers.size} issuer aggregate rows.`);
}

async function doBithomp(prisma) {
  if (!BITHOMP_KEY) throw new Error('BITHOMP_API_KEY not set — cannot run --bithomp.');
  const known = await prisma.indexedMptIssuer.findMany({ select: { issuer: true } });
  const issuers = [...new Set([...BOOTSTRAP_ISSUERS, ...known.map((k) => k.issuer)])];
  let totalRows = 0;
  for (const issuer of issuers) {
    let ok = false;
    for (let attempt = 0; attempt < 4 && !ok; attempt++) {
      try {
        // Bithomp free tier caps limit at 100; marker pagination is paid.
        const res = await fetch(`${BITHOMP_BASE}/mptokens?issuer=${issuer}&limit=100`, {
          headers: { 'x-bithomp-token': BITHOMP_KEY }, signal: AbortSignal.timeout(25000),
        });
        const j = await res.json();
        if (j.error) throw new Error(j.error);
        const list = j.issuances || [];
        for (const b of list) {
          let flagsRaw = 0;
          if (b.flags) for (const k of Object.keys(FLAG)) if (b.flags[k]) flagsRaw |= FLAG[k];
          const meta = b.metadata ? JSON.stringify(b.metadata) : null;
          const nm = (b.metadata && (b.metadata.name || b.metadata.ticker)) || b.currency || null;
          if (await upsertRow(prisma, {
            issuanceId: String(b.mptokenIssuanceID || '').toUpperCase(),
            issuer: String(b.issuer || ''),
            sequence: typeof b.sequence === 'number' ? b.sequence : null,
            assetScale: typeof b.scale === 'number' ? b.scale : 0,
            maxAmount: b.maximumAmount != null ? String(b.maximumAmount) : null,
            outstanding: b.outstandingAmount != null ? String(b.outstandingAmount) : '0',
            transferFee: typeof b.transferFee === 'number' ? b.transferFee : 0,
            flagsRaw, metadata: meta, name: nm ? String(nm).trim() : null,
            holderCount: typeof b.holders === 'number' ? b.holders : (typeof b.mptokens === 'number' ? b.mptokens : null),
            source: 'bithomp',
          }, 0)) totalRows++;
        }
        const n = await refreshAggregate(prisma, issuer);
        console.log(`  ${issuer}: ${list.length} from bithomp ${j.marker ? '(CAPPED >250)' : ''} — issuer now has ${n} indexed`);
        ok = true;
      } catch (e) {
        console.error(`  ${issuer} attempt ${attempt + 1}: ${e.message}`);
        await sleep(8000);
      }
    }
    await sleep(6500); // 10 req/min free-tier ceiling
  }
  console.log(`\nBithomp pull done. ${totalRows} rows upserted.`);
}

async function doWalk(prisma, once) {
  let client = await connectMainnetOrThrow();
  let endpointOffset = 0, consecutiveFailures = 0, forceRestartMarker = false, pageCount = 0;
  try {
    for (;;) {
      let cp = await prisma.indexerCheckpoint.findUnique({ where: { id: CHECKPOINT_ID } });
      if (!cp) cp = await prisma.indexerCheckpoint.create({ data: { id: CHECKPOINT_ID } });
      const isNewPass = cp.status === 'idle';
      const passNumber = isNewPass ? cp.passNumber + 1 : cp.passNumber;
      const marker = isNewPass || forceRestartMarker ? null : cp.marker;
      forceRestartMarker = false;
      if (isNewPass) {
        console.log(`Starting MPT walk pass ${passNumber}...`);
        await prisma.indexerCheckpoint.update({
          where: { id: CHECKPOINT_ID },
          data: { status: 'running', passNumber, passStartedAt: new Date(), marker: null },
        });
      }

      let nowRipple, ledgerIndex, res;
      try {
        const lr = await requestWithRetry(client, { command: 'ledger', ledger_index: 'validated' });
        nowRipple = lr.result?.ledger?.close_time;
        ledgerIndex = Number(lr.result?.ledger_index) || null;
        res = await requestWithRetry(client, {
          command: 'ledger_data', ledger_index: 'validated', type: 'mpt_issuance',
          limit: PAGE_LIMIT, ...(marker ? { marker } : {}),
        });
        consecutiveFailures = 0;
      } catch (err) {
        if (isMarkerError(err)) {
          console.warn(`Marker rejected (node handoff) — restarting pass ${passNumber}. Collected rows kept.`);
          forceRestartMarker = true;
          continue;
        }
        consecutiveFailures++;
        console.error(`Page failed (${consecutiveFailures}/${MAX_CONSECUTIVE_PAGE_FAILURES}): ${err.message || err}`);
        if (consecutiveFailures >= MAX_CONSECUTIVE_PAGE_FAILURES) {
          throw new Error(`Giving up after ${MAX_CONSECUTIVE_PAGE_FAILURES} consecutive failures. Checkpoint saved — re-run to resume.`);
        }
        await client.disconnect().catch(() => {});
        endpointOffset = (endpointOffset + 1) % MAINNET_ENDPOINTS.length;
        await sleep(2000);
        client = await connectMainnetOrThrow(endpointOffset);
        continue;
      }

      let seen = 0;
      for (const node of res.result.state || []) {
        if (node.LedgerEntryType !== 'MPTokenIssuance') continue;
        const seq = typeof node.Sequence === 'number' ? node.Sequence : null;
        const metaHex = typeof node.MPTokenMetadata === 'string' ? node.MPTokenMetadata : null;
        const meta = metaHex ? safeDecode(metaHex) : null;
        const id = typeof node.mpt_issuance_id === 'string'
          ? String(node.mpt_issuance_id).toUpperCase()
          : (seq != null && node.Issuer ? deriveIssuanceId(seq, String(node.Issuer)) : '');
        if (await upsertRow(prisma, {
          issuanceId: id, issuer: String(node.Issuer || ''), sequence: seq,
          assetScale: Number(node.AssetScale || 0),
          maxAmount: node.MaximumAmount != null ? String(node.MaximumAmount) : null,
          outstanding: String(node.OutstandingAmount || '0'),
          transferFee: Number(node.TransferFee || 0),
          flagsRaw: Number(node.Flags || 0), metadata: meta, name: nameFromMeta(meta),
          holderCount: null, ledgerIndex, source: 'walk',
        }, passNumber)) seen++;
      }
      pageCount++;
      if (pageCount % 25 === 0 || seen > 0) {
        process.stdout.write(`  page ${pageCount}: +${seen} MPTokenIssuance, marker=${res.result.marker ? 'more' : 'END'}\n`);
      }

      const nextMarker = res.result.marker || null;
      if (!nextMarker) {
        await prisma.indexedMPT.deleteMany({ where: { sources: 'walk', passNumber: { lt: passNumber } } });
        const completedAt = new Date();
        await prisma.indexerCheckpoint.update({
          where: { id: CHECKPOINT_ID },
          data: { status: 'idle', marker: null, lastCompletedPassAt: completedAt, lastCompletedPassNumber: passNumber, lastLedgerCloseTime: nowRipple },
        });
        const total = await prisma.indexedMPT.count();
        const issuers = await prisma.indexedMPT.findMany({ select: { issuer: true }, distinct: ['issuer'] });
        for (const it of issuers) await refreshAggregate(prisma, it.issuer);
        console.log(`\nMPT walk pass ${passNumber} complete at ${completedAt.toISOString()}. ${total} issuances / ${issuers.length} issuers indexed.`);
        break;
      }
      await prisma.indexerCheckpoint.update({
        where: { id: CHECKPOINT_ID },
        data: { marker: nextMarker, lastLedgerCloseTime: nowRipple },
      });
      if (once) { console.log('--once: stopping after one page.'); break; }
    }
  } finally {
    await client.disconnect().catch(() => {});
  }
}

async function main() {
  const args = process.argv.slice(2);
  const prisma = new PrismaClient();
  try {
    if (args.includes('--status')) return void (await doStatus(prisma));
    if (args.includes('--seed')) return void (await doSeed(prisma));
    if (args.includes('--bithomp')) return void (await doBithomp(prisma));
    await doWalk(prisma, args.includes('--once'));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });

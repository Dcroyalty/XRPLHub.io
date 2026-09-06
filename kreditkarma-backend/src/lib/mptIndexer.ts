// src/lib/mptIndexer.ts
// The MPTokenIssuance registry refresh, resumable across bounded invocations.
// Two sources, unioned into IndexedMPT:
//
//   A. Bithomp per-issuer (?issuer=, free + uncapped): fast and complete per
//      issuer, but only covers issuers we already know. Round-robined — the
//      stalest N issuers are refreshed each call so a daily cron cycles the
//      whole set every few days; the hand-run script does all of them at once.
//   B. Our own ledger_data walk (type: mpt_issuance): authoritative for
//      existence and the only way to discover an issuer nobody told us about,
//      but a full pass is thousands of pages. Advanced from the persisted
//      "mpt" IndexerCheckpoint for whatever budget is left.
//
// Coverage stays "partial" (see mptIndex.mptCoverage) until B completes a
// full pass — the read routes must never present the union as the whole
// population before then.
//
// Read by /api/cron/index-mpts (bounded) and scripts/census-mpts.cjs (hand-run).

import type { Client } from "xrpl";
import type { PrismaClient } from "@prisma/client";
import { connectMainnetOrThrow, validatedLedgerCloseTimeRipple } from "./credentials";
import { scoreWallet, AccountNotFoundError } from "./xrplscore";
import { bithompMptsByIssuer, bithompRecentMpts } from "./bithomp";
import {
  MPT_CHECKPOINT_ID,
  MPT_BOOTSTRAP_ISSUERS,
  mptRowFromLedgerNode,
  mptRowFromBithomp,
  mptSearchText,
  issuanceIdsHash,
  mptCoverage,
  type MptRowInput,
} from "./mptIndex";
import {
  CANON_VERSION,
  computeRegistrySnapshot,
  buildAnchorMemo,
  submitAnchorTx,
  type AnchorMemoPayload,
} from "./mptAnchor";
import { notifyError } from "./notify";

const PAGE_LIMIT = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function isMarkerError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err);
  return /markerMalformed|invalid.*marker/i.test(msg);
}
async function requestWithRetry(client: Client, req: Parameters<Client["request"]>[0], attempts = 3) {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await client.request(req);
    } catch (err) {
      lastErr = err;
      if (isMarkerError(err)) break;
      if (i < attempts - 1) await sleep(1000 * 2 ** i);
    }
  }
  throw lastErr;
}

/** Upsert one IndexedMPT row, merging the `sources` set. */
async function upsertRow(prisma: PrismaClient, row: MptRowInput, passNumber: number) {
  if (!/^[0-9A-F]{48}$/.test(row.issuanceId) || !row.issuer) return false;
  const existing = await prisma.indexedMPT.findUnique({
    where: { issuanceId: row.issuanceId },
    select: { sources: true },
  });
  const sources = new Set((existing?.sources ?? "").split(",").filter(Boolean));
  sources.add(row.source);
  const common = {
    issuer: row.issuer,
    sequence: row.sequence,
    assetScale: row.assetScale,
    maxAmount: row.maxAmount,
    outstanding: row.outstanding,
    transferFee: row.transferFee,
    flagsRaw: row.flagsRaw,
    metadata: row.metadata,
    name: row.name,
    ticker: row.ticker,
    searchText: mptSearchText(row.name, row.ticker),
    sources: [...sources].sort().join(","),
    ...(row.holderCount != null ? { holderCount: row.holderCount } : {}),
    ...(row.source === "walk" ? { passNumber, ledgerIndex: row.ledgerIndex } : {}),
  };
  await prisma.indexedMPT.upsert({
    where: { issuanceId: row.issuanceId },
    create: { issuanceId: row.issuanceId, ...common },
    update: common,
  });
  return true;
}

/** Recompute the per-issuer aggregate; rescore only if the id set changed.
 *  `capped` = Bithomp returned a marker (issuer has >100 issuances) — recorded
 *  so mptCoverage() can drop "complete-per-known-issuer" while it's true. */
async function refreshIssuerAggregate(prisma: PrismaClient, issuer: string, forceScore = false, capped?: boolean) {
  const rows = await prisma.indexedMPT.findMany({ where: { issuer }, select: { issuanceId: true } });
  const hash = issuanceIdsHash(rows.map((r) => r.issuanceId));
  const prev = await prisma.indexedMptIssuer.findUnique({ where: { issuer } });
  const changed = !prev || prev.issuanceIdsHash !== hash;

  let score = prev?.xrplScore ?? null;
  let grade = prev?.grade ?? null;
  let scoredAt = prev?.scoredAt ?? null;

  if (changed || forceScore) {
    try {
      const s = await scoreWallet(issuer);
      score = s.ledgerScore;
      grade = s.grade;
      scoredAt = new Date();
    } catch (err) {
      if (err instanceof AccountNotFoundError) {
        score = null;
        grade = null;
        scoredAt = new Date();
      }
      // any other error: leave the previous score in place
    }
  }

  const cappedField = capped === undefined ? {} : { bithompCapped: capped };
  await prisma.indexedMptIssuer.upsert({
    where: { issuer },
    create: { issuer, mptCount: rows.length, issuanceIdsHash: hash, xrplScore: score, grade, scoredAt, ...cappedField },
    update: { mptCount: rows.length, issuanceIdsHash: hash, xrplScore: score, grade, scoredAt, ...cappedField },
  });
  return { changed, mptCount: rows.length };
}

export interface MptPassProgress {
  bithomp: { issuersRefreshed: string[]; rowsUpserted: number; issuersRescored: string[] };
  walk: {
    status: "idle" | "running";
    passNumber: number;
    pagesWalked: number;
    objectsSeen: number;
    completed: boolean;
    lastCompletedPassAt: string | null;
  };
}

export async function runMptIndexerPass(
  prisma: PrismaClient,
  opts: { budgetMs?: number; bithompSlice?: number } = {}
): Promise<MptPassProgress> {
  const budgetMs = opts.budgetMs ?? 50_000; // margin under Hobby's 60s
  const bithompSlice = opts.bithompSlice ?? 6;
  const startedAt = Date.now();

  let checkpoint = await prisma.indexerCheckpoint.findUnique({ where: { id: MPT_CHECKPOINT_ID } });
  if (!checkpoint) checkpoint = await prisma.indexerCheckpoint.create({ data: { id: MPT_CHECKPOINT_ID } });

  // ── Phase A: Bithomp per-issuer, stalest first ────────────────────────────
  const knownRows = await prisma.indexedMptIssuer.findMany({
    orderBy: { lastRefreshedAt: "asc" },
    select: { issuer: true },
  });
  const knownSet = new Set(knownRows.map((k) => k.issuer));
  const bootstrapPending = MPT_BOOTSTRAP_ISSUERS.filter((b) => !knownSet.has(b));

  // Cheap discovery: Bithomp's newest issuances across all issuers.
  const recent = await bithompRecentMpts(100).catch(() => null);
  const discovered = new Set<string>();
  if (recent) {
    for (const r of recent) {
      if (r.issuer && !knownSet.has(r.issuer) && !MPT_BOOTSTRAP_ISSUERS.includes(r.issuer)) {
        discovered.add(r.issuer);
      }
    }
  }
  // Newly-seen issuers first, then bootstrap issuers we've never pulled, then
  // the known set stalest-first.
  const refreshOrder = [...discovered, ...bootstrapPending, ...knownRows.map((k) => k.issuer)];

  const issuersRefreshed: string[] = [];
  const issuersRescored: string[] = [];
  let rowsUpserted = 0;
  for (const issuer of refreshOrder) {
    if (issuersRefreshed.length >= bithompSlice) break;
    if (Date.now() - startedAt > budgetMs * 0.55) break; // leave >=45% of budget for the walk
    const got = await bithompMptsByIssuer(issuer);
    if (!got) {
      // still touch the aggregate so lastRefreshedAt advances and we don't get stuck on a failing issuer
      await refreshIssuerAggregate(prisma, issuer).catch(() => {});
      issuersRefreshed.push(issuer);
      await sleep(6500);
      continue;
    }
    for (const b of got.issuances) {
      if (await upsertRow(prisma, mptRowFromBithomp(b), checkpoint.passNumber)) rowsUpserted++;
    }
    const agg = await refreshIssuerAggregate(prisma, issuer, false, got.capped);
    if (agg.changed) issuersRescored.push(issuer);
    issuersRefreshed.push(issuer);
    await sleep(6500); // 10 req/min free-tier ceiling
  }

  // ── Phase B: advance the ledger_data walk ─────────────────────────────────
  const isNewPass = checkpoint.status === "idle";
  const passNumber = isNewPass ? checkpoint.passNumber + 1 : checkpoint.passNumber;
  let marker: string | null = isNewPass ? null : checkpoint.marker;

  const client: Client = await connectMainnetOrThrow();
  let pagesWalked = 0;
  let objectsSeen = 0;
  let completed = false;
  try {
    const nowRipple = await validatedLedgerCloseTimeRipple(client);
    if (isNewPass) {
      await prisma.indexerCheckpoint.update({
        where: { id: MPT_CHECKPOINT_ID },
        data: { status: "running", passNumber, passStartedAt: new Date(), marker: null },
      });
    }
    const ledgerRes = await requestWithRetry(client, { command: "ledger", ledger_index: "validated" } as Parameters<Client["request"]>[0]);
    const ledgerIndex = Number((ledgerRes.result as { ledger_index?: number }).ledger_index ?? 0) || null;

    while (Date.now() - startedAt < budgetMs) {
      let res;
      try {
        res = await requestWithRetry(client, {
          command: "ledger_data",
          ledger_index: "validated",
          type: "mpt_issuance",
          limit: PAGE_LIMIT,
          ...(marker ? { marker } : {}),
        } as unknown as Parameters<typeof client.request>[0]);
      } catch (err) {
        if (isMarkerError(err) && marker !== null) {
          marker = null; // node handoff — restart the pass, rows keep their passNumber and get re-confirmed
          continue;
        }
        throw err;
      }
      const result = res.result as { state?: Record<string, unknown>[]; marker?: string };
      pagesWalked++;
      for (const node of result.state ?? []) {
        if (node.LedgerEntryType !== "MPTokenIssuance") continue;
        const row = mptRowFromLedgerNode(node);
        row.ledgerIndex = ledgerIndex;
        if (await upsertRow(prisma, row, passNumber)) objectsSeen++;
      }
      marker = result.marker ?? null;
      if (!marker) {
        completed = true;
        break;
      }
    }

    if (completed) {
      // Prune only rows that came ONLY from the walk and weren't re-confirmed
      // this pass — a bithomp-sourced row is left alone (that source has its
      // own freshness via lastRefreshedAt).
      await prisma.indexedMPT.deleteMany({ where: { sources: "walk", passNumber: { lt: passNumber } } });
      const completedAt = new Date();
      await prisma.indexerCheckpoint.update({
        where: { id: MPT_CHECKPOINT_ID },
        data: {
          status: "idle", marker: null,
          lastCompletedPassAt: completedAt, lastCompletedPassNumber: passNumber,
          lastLedgerCloseTime: nowRipple,
        },
      });
      // A completed pass may have found issuers not in any aggregate yet.
      const orphans = await prisma.indexedMPT.findMany({
        where: { issuer: { notIn: (await prisma.indexedMptIssuer.findMany({ select: { issuer: true } })).map((r) => r.issuer) } },
        select: { issuer: true },
        distinct: ["issuer"],
      });
      for (const o of orphans.slice(0, 5)) await refreshIssuerAggregate(prisma, o.issuer).catch(() => {});
    } else {
      await prisma.indexerCheckpoint.update({
        where: { id: MPT_CHECKPOINT_ID },
        data: { marker, lastLedgerCloseTime: nowRipple },
      });
    }

    const cpAfter = await prisma.indexerCheckpoint.findUnique({ where: { id: MPT_CHECKPOINT_ID } });
    return {
      bithomp: { issuersRefreshed, rowsUpserted, issuersRescored },
      walk: {
        status: completed ? "idle" : "running",
        passNumber,
        pagesWalked,
        objectsSeen,
        completed,
        lastCompletedPassAt: cpAfter?.lastCompletedPassAt ? cpAfter.lastCompletedPassAt.toISOString() : null,
      },
    };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

// ── On-ledger anchoring ──────────────────────────────────────────────────────

const ANCHOR_MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;     // don't anchor more than ~once a day
const ANCHOR_MAX_INTERVAL_MS = 8 * 24 * 60 * 60 * 1000; // re-anchor even if unchanged, as a liveness proof

export interface AnchorAttempt {
  attempted: boolean;
  submitted: boolean;
  /** "misconfigured" fails on every run until an env var is fixed; "transient" may succeed next run. */
  faultClass?: "misconfigured" | "transient";
  reason: string;
  merkleRoot: string;
  issuanceCount: number;
  issuerCount: number;
  coverage: string;
  anchorId?: string;
  txHash?: string;
}

/**
 * Called at the end of a cron pass. Computes the registry Merkle root; if
 * MPT_ANCHOR_ENABLED === "true" and an anchor is due, submits the anchor tx
 * from the issuer wallet and records it. Otherwise records a `pending`
 * snapshot row (deduped by root) so GET /api/mpt/anchor can show what WOULD
 * be anchored. Never submits for a "partial" coverage snapshot unless the
 * memo carries the coverage figure (it always does).
 */
export async function maybeAnchor(prisma: PrismaClient): Promise<AnchorAttempt> {
  const [snap, cov] = await Promise.all([computeRegistrySnapshot(prisma), mptCoverage(prisma)]);
  const base = {
    merkleRoot: snap.merkleRoot,
    issuanceCount: snap.issuanceCount,
    issuerCount: snap.issuerCount,
    coverage: cov.coverage,
  };

  const existing = await prisma.mptAnchor.findFirst({ where: { merkleRoot: snap.merkleRoot }, orderBy: { createdAt: "desc" } });
  const lastAnchored = await prisma.mptAnchor.findFirst({ where: { status: "anchored" }, orderBy: { createdAt: "desc" } });
  const now = Date.now();
  const payload: AnchorMemoPayload = {
    root: snap.merkleRoot,
    issuances: snap.issuanceCount,
    issuers: snap.issuerCount,
    coverage: cov.coverage,
    freshnessFloor: cov.freshnessFloorAt,
    ts: new Date().toISOString(),
  };
  const memo = buildAnchorMemo(payload).memoData;

  const gateOn = process.env.MPT_ANCHOR_ENABLED === "true";
  const signingKeyPresent = !!process.env.ANCHOR_WALLET_SEED;

  // Screaming misconfiguration: anchoring turned on, no key to sign with. This
  // fails identically on every single run until the key is added to the env.
  if (gateOn && !signingKeyPresent) {
    const msg =
      "MPT_ANCHOR_ENABLED='true' but ANCHOR_WALLET_SEED is not set — the anchor cannot be signed. " +
      "No anchor will be produced on any run until the dedicated anchor-wallet seed is added to the environment.";
    const row =
      existing ??
      (await prisma.mptAnchor.create({
        data: {
          canonVersion: CANON_VERSION, merkleRoot: snap.merkleRoot,
          issuanceCount: snap.issuanceCount, issuerCount: snap.issuerCount,
          coverage: cov.coverage, freshnessFloorAt: cov.freshnessFloorAt ? new Date(cov.freshnessFloorAt) : null,
          memo, status: "misconfigured", error: msg,
        },
      }));
    if (row.status !== "misconfigured" || row.error !== msg) {
      await prisma.mptAnchor.update({ where: { id: row.id }, data: { status: "misconfigured", error: msg } });
    }
    await notifyError("cron/index-mpts anchor", new Error(msg), { merkleRoot: snap.merkleRoot, issuers: snap.issuerCount });
    return { ...base, attempted: false, submitted: false, faultClass: "misconfigured", reason: msg, anchorId: row.id };
  }

  if (!gateOn) {
    if (!existing) {
      await prisma.mptAnchor.create({
        data: {
          canonVersion: CANON_VERSION, merkleRoot: snap.merkleRoot,
          issuanceCount: snap.issuanceCount, issuerCount: snap.issuerCount,
          coverage: cov.coverage, freshnessFloorAt: cov.freshnessFloorAt ? new Date(cov.freshnessFloorAt) : null,
          memo, status: "pending",
        },
      });
    }
    return { ...base, attempted: false, submitted: false, reason: "MPT_ANCHOR_ENABLED != 'true' — recorded a pending snapshot only, no tx submitted." };
  }

  if (existing?.status === "anchored") {
    return { ...base, attempted: false, submitted: false, reason: "this exact root is already anchored on-ledger.", anchorId: existing.id, txHash: existing.txHash ?? undefined };
  }
  if (lastAnchored && now - lastAnchored.createdAt.getTime() < ANCHOR_MIN_INTERVAL_MS) {
    return { ...base, attempted: false, submitted: false, reason: "last anchor was less than ~20h ago." };
  }
  const rootUnchanged = lastAnchored?.merkleRoot === snap.merkleRoot;
  const staleEnough = !lastAnchored || now - lastAnchored.createdAt.getTime() >= ANCHOR_MAX_INTERVAL_MS;
  if (rootUnchanged && !staleEnough) {
    return { ...base, attempted: false, submitted: false, reason: "root unchanged since the last anchor and it is less than 8 days old." };
  }

  const row = existing ?? (await prisma.mptAnchor.create({
    data: {
      canonVersion: CANON_VERSION, merkleRoot: snap.merkleRoot,
      issuanceCount: snap.issuanceCount, issuerCount: snap.issuerCount,
      coverage: cov.coverage, freshnessFloorAt: cov.freshnessFloorAt ? new Date(cov.freshnessFloorAt) : null,
      memo, status: "pending",
    },
  }));

  try {
    const r = await submitAnchorTx(payload);
    if (!r.validated || r.engineResult !== "tesSUCCESS") {
      throw new Error(`tx not successful: engineResult=${r.engineResult}, validated=${r.validated}`);
    }
    await prisma.mptAnchor.update({
      where: { id: row.id },
      data: { status: "anchored", txHash: r.txHash, ledgerIndex: r.ledgerIndex, account: r.account, feeDrops: r.feeDrops, anchoredAt: new Date(), error: null },
    });
    return { ...base, attempted: true, submitted: true, reason: "anchored", anchorId: row.id, txHash: r.txHash };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A config problem (bad/absent seed, wrong wallet) fails forever; a network
    // / ledger error may clear next run. Both are recorded and alerted.
    const misconfig = /ANCHOR_WALLET_SEED|REFUSING:|derives .* expected/i.test(msg);
    const status = misconfig ? "misconfigured" : "failed";
    await prisma.mptAnchor.update({ where: { id: row.id }, data: { status, error: msg } });
    await notifyError("cron/index-mpts anchor", err, {
      faultClass: misconfig ? "misconfigured" : "transient",
      merkleRoot: snap.merkleRoot,
    });
    return {
      ...base, attempted: true, submitted: false,
      faultClass: misconfig ? "misconfigured" : "transient",
      reason: `anchor submit failed (${status}): ${msg}`, anchorId: row.id,
    };
  }
}

// src/lib/screenBackup.ts
// Off-Neon durability for the 10-year screening-receipt retention promise (docs/CREDENTIAL-SPEC.md is the credential
// equivalent; this is the screening-receipt one — see /legal/screening#retention and SCREEN_RETENTION_TEXT).
//
// Neon's own history is 6 hours on the current plan; the retention PROMISE is 10 years. A database problem, an
// account issue, or a plan change must not be able to take every screening receipt with it. So once a day, every
// receipt screened the PREVIOUS UTC day is written to a durable, independent store — a PRIVATE GitHub repo
// (Dcroyalty/xrplhub-screening-backups, separate from the public app repo), as a plain JSONL file per day, committed
// via the GitHub Contents API. One receipt is one line; the file for a day is deterministic (sorted by queryId) so
// re-running a day is a content-identical no-op, not a new commit.
//
// This repo MUST stay private. A receipt contains subjectAddress and requestedBy (a customer's own API key
// prefix) — retaining that data for 10 years is the promise; publishing it is a privacy violation, not retention.
// The anchored Merkle root is meant to be public (that's the point of anchoring); the leaf/receipt data behind it is
// not, and never goes in the public app repo again.
//
// This does not replace Neon (verify/export still read from Postgres) — it is the second, independent copy the
// retention promise needs. It also does not need the credential issuer's key or any signing key: a GitHub PAT
// scoped ONLY to the backup repo, contents read/write, is enough, kept in `GITHUB_TOKEN` (fine-grained token —
// never a classic repo-scope PAT that can reach other repos). Absent that token, the job SKIPS with a clear, loud
// reason (never silently) — see docs/AUTONOMY.md's section on this.

import type { PrismaClient } from "@prisma/client";
import { rebuildReceipt, loadAnchorContexts, proofFor, type ReceiptRowLike } from "./screenRebuild";
import { verifyInclusion } from "./merkle";
import { notifyError } from "./notify";

const GITHUB_API = "https://api.github.com";
// PRIVATE repo, separate from the public app repo — never point this at Dcroyalty/XRPLHub.io again (see header comment).
const DEFAULT_REPO = "Dcroyalty/xrplhub-screening-backups";
const BACKUP_PATH_PREFIX = "backups/screening-receipts";
const CHECKPOINT_ID = "screening-backup:last-completed-date";
const DAY_MS = 86_400_000;
/** How many past days a single run will attempt, oldest first — bounded so a big backlog can't blow the cron's deadline. */
const MAX_DAYS_PER_RUN = 5;

function dayBounds(dateISO: string): { start: Date; end: Date } {
  const start = new Date(`${dateISO}T00:00:00.000Z`);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

/** Every receipt screened on `dateISO` (UTC), as deterministic JSONL — one self-contained, verifiable receipt per line. */
export async function buildDailyBackup(prisma: PrismaClient, dateISO: string): Promise<{ content: string; count: number }> {
  const { start, end } = dayBounds(dateISO);
  const rows = await prisma.screeningReceipt.findMany({ where: { screenedAt: { gte: start, lt: end } }, orderBy: { queryId: "asc" } });
  if (rows.length === 0) return { content: "", count: 0 };

  const contexts = await loadAnchorContexts(prisma, rows.flatMap((r) => (r.anchorId ? [r.anchorId] : [])));
  const lines = rows.map((row) => {
    const rb = rebuildReceipt(row as ReceiptRowLike);
    const ctx = row.anchorId ? contexts.get(row.anchorId) : undefined;
    let anchor: Record<string, unknown> | null = null;
    if (ctx) {
      const { index, proof } = proofFor(ctx, row.queryId);
      anchor = {
        status: ctx.anchor.status,
        txHash: ctx.anchor.txHash,
        ledgerIndex: ctx.anchor.ledgerIndex,
        merkleRoot: ctx.anchor.merkleRoot,
        leafIndex: index,
        inclusionProof: proof,
        inclusionProofValid: index >= 0 && verifyInclusion(row.leafHash, proof, ctx.anchor.merkleRoot),
      };
    }
    return JSON.stringify({
      queryId: row.queryId,
      screenedAt: row.screenedAt.toISOString(),
      subjectAddress: row.subjectAddress,
      subjectChain: row.subjectChain,
      reference: row.reference,
      requestedBy: row.requestedBy,
      batchId: row.batchId,
      lists: row.listsJson,
      result: row.resultJson,
      engineVersion: row.engineVersion,
      canonVersion: row.canonVersion,
      retentionCode: row.retentionCode,
      canonicalLeaf: rb.canonicalJson,
      leafHash: row.leafHash,
      leafHashMatches: rb.leafHashMatches,
      statement: rb.statement,
      anchor,
    });
  });
  return { content: lines.join("\n") + "\n", count: rows.length };
}

interface GitHubPutResult {
  ok: boolean;
  status: number;
  unchanged?: boolean;
  detail?: string;
}

/** Create or update one file in the backup repo via the GitHub Contents API. Idempotent: identical content is a no-op (still 200/201, no new commit needed if sha matches — GitHub itself no-ops an identical PUT). */
async function putGitHubFile(token: string, repo: string, path: string, content: string, message: string): Promise<GitHubPutResult> {
  const url = `${GITHUB_API}/repos/${repo}/contents/${path}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" };
  let sha: string | undefined;
  const existing = await fetch(url, { headers }).catch(() => null);
  if (existing?.ok) {
    const j = (await existing.json()) as { sha?: string; content?: string; encoding?: string };
    sha = j.sha;
    if (j.encoding === "base64" && j.content) {
      const current = Buffer.from(j.content.replace(/\n/g, ""), "base64").toString("utf8");
      if (current === content) return { ok: true, status: 200, unchanged: true };
    }
  } else if (existing && existing.status !== 404) {
    return { ok: false, status: existing.status, detail: `GET ${path} -> ${existing.status}` };
  }
  const res = await fetch(url, {
    method: "PUT",
    headers,
    body: JSON.stringify({ message, content: Buffer.from(content, "utf8").toString("base64"), ...(sha ? { sha } : {}) }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, status: res.status, detail: body.slice(0, 300) };
  }
  return { ok: true, status: res.status };
}

export interface BackupRunResult {
  ran: boolean;
  reason?: string;
  daysProcessed: string[];
  daysFailed: Array<{ date: string; detail: string }>;
  receiptsBackedUp: number;
}

/**
 * Back up every day since the last completed one, oldest first, up to MAX_DAYS_PER_RUN, stopping at (not including)
 * TODAY (a day already fully in the past never gets new receipts, so it is safe to mark done once written; today is
 * still accumulating and is left for tomorrow's run). Resumable: a day is only checkpointed after its file is
 * confirmed written, so a crash mid-run just repeats that day next time (idempotent — see putGitHubFile).
 */
export async function runScreeningBackup(prisma: PrismaClient, opts: { deadlineMs?: number } = {}): Promise<BackupRunResult> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { ran: false, reason: "GITHUB_TOKEN is not set — the 10-year retention promise has no off-Neon backup running. See docs/AUTONOMY.md.", daysProcessed: [], daysFailed: [], receiptsBackedUp: 0 };
  }
  const repo = process.env.GITHUB_BACKUP_REPO || DEFAULT_REPO;
  const deadline = opts.deadlineMs ?? Date.now() + 20_000;

  const cp = await prisma.indexerCheckpoint.findUnique({ where: { id: CHECKPOINT_ID } });
  const earliest = await prisma.screeningReceipt.findFirst({ orderBy: { screenedAt: "asc" }, select: { screenedAt: true } });
  if (!earliest) return { ran: true, daysProcessed: [], daysFailed: [], receiptsBackedUp: 0 };

  const lastDone = cp?.marker ? new Date(`${cp.marker}T00:00:00.000Z`) : new Date(earliest.screenedAt.toISOString().slice(0, 10) + "T00:00:00.000Z");
  const startDay = cp?.marker ? new Date(lastDone.getTime() + DAY_MS) : lastDone; // resume AFTER the last completed day, or start at the earliest day
  const todayStart = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");

  const daysProcessed: string[] = [];
  const daysFailed: Array<{ date: string; detail: string }> = [];
  let receiptsBackedUp = 0;

  let cursor = startDay;
  let attempts = 0;
  while (cursor.getTime() < todayStart.getTime() && attempts < MAX_DAYS_PER_RUN && Date.now() < deadline) {
    const dateISO = cursor.toISOString().slice(0, 10);
    attempts++;
    try {
      const { content, count } = await buildDailyBackup(prisma, dateISO);
      if (count > 0) {
        const r = await putGitHubFile(token, repo, `${BACKUP_PATH_PREFIX}/${dateISO}.jsonl`, content, `screening receipts backup ${dateISO} (${count} receipt${count === 1 ? "" : "s"})`);
        if (!r.ok) {
          daysFailed.push({ date: dateISO, detail: `GitHub ${r.status}: ${r.detail ?? ""}` });
          break; // stop at the first failure — do not checkpoint past a day that did not actually get written
        }
        receiptsBackedUp += count;
      }
      await prisma.indexerCheckpoint.upsert({
        where: { id: CHECKPOINT_ID },
        create: { id: CHECKPOINT_ID, status: "idle", marker: dateISO, lastCompletedPassAt: new Date() },
        update: { marker: dateISO, lastCompletedPassAt: new Date() },
      });
      daysProcessed.push(dateISO);
    } catch (e) {
      daysFailed.push({ date: dateISO, detail: e instanceof Error ? e.message : String(e) });
      break;
    }
    cursor = new Date(cursor.getTime() + DAY_MS);
  }

  // Quiet on success (routine, daily) — loud only on failure, matching every other daily step in this cron.
  if (daysFailed.length) await notifyError("screening-backup", new Error(`backup failed for ${daysFailed.map((d) => d.date).join(", ")}`), { daysFailed });
  return { ran: true, daysProcessed, daysFailed, receiptsBackedUp };
}

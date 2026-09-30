// src/lib/credentialAutoIssue.ts
// Processes the CredentialRequest queue automatically -- the server-side replacement for hand-running
// scripts/issue-queued-credentials.cjs --issue. Dormant by design: every function here is a genuine
// no-op whenever CREDENTIAL_ISSUER_SEED is unset (the operator-only posture every issue*Credential()
// function already enforces on its own), so wiring this into a cron is safe BEFORE the seed is ever
// added to Vercel -- it starts doing real work the moment it's set, nothing more needs to change.
//
// GUARDRAILS (per the owner's explicit ask):
//   1. Fresh re-verification at signing time -- already true: every issue*Credential() function
//      re-scores/re-screens/re-checks the underlying fact immediately before signing, never trusting
//      the state the request was queued under. This module doesn't add that; it was already the design.
//   2. A daily issuance cap, counted from the DATABASE (CredentialRequest.status='issued' since UTC
//      midnight) rather than an in-memory counter -- self-healing across deploys/cold-starts, can't drift.
//   3. A per-run cap too (bounded like every other cron step in this app), so one slow run can't itself
//      blow past the daily figure before the next cron catches up.
//   4. Ledger-based anomaly watchdog -- see credentialAnomalyWatch.ts, not this file: it reads the
//      issuer's own on-chain history and cross-checks it against what THIS module actually issued,
//      independent of whether this code path is what put a given CredentialCreate on the ledger.

import type { PrismaClient } from "@prisma/client";
import { planScoreCredential, issueScoreCredential, ScoreNotEligibleError } from "./credentials";
import { planMptDeclaredCredential, issueMptDeclaredCredential } from "./mptCredential";
import { planScreenCredential, issueScreenCredential, ScreenCredListedError } from "./screenCredential";
import { planDomainCredential, issueDomainCredential } from "./domainCredential";

export const DEFAULT_DAILY_CAP = 20;
export const MAX_PER_RUN = 5; // bounded like every other cron step; the next run picks up where this one stopped

function dailyCap(): number {
  const n = Number(process.env.CREDENTIAL_DAILY_CAP);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_DAILY_CAP;
}

export interface AutoIssueOutcome {
  requestId: string;
  kind: string;
  subject: string;
  result: "issued" | "failed" | "skipped_cap";
  txHash?: string;
  reason?: string;
}

export interface AutoIssueRunResult {
  ran: boolean;
  reason?: string;
  issuedToday: number;
  cap: number;
  processed: AutoIssueOutcome[];
}

/** How many requests have already been issued since UTC midnight today -- the daily cap's live count. */
async function issuedSinceMidnightUtc(prisma: PrismaClient): Promise<number> {
  const todayStart = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");
  return prisma.credentialRequest.count({ where: { status: "issued", issuedAt: { gte: todayStart } } });
}

/**
 * Process up to MAX_PER_RUN queued requests, oldest first, stopping the moment the daily cap is hit.
 * No-ops cleanly (ran:false) if CREDENTIAL_ISSUER_SEED is unset -- the queue is simply left for the next
 * run (or a human running the CLI scripts), exactly as it behaves today.
 */
export async function runAutoIssuance(prisma: PrismaClient, opts: { deadlineMs?: number } = {}): Promise<AutoIssueRunResult> {
  const cap = dailyCap();
  if (!process.env.CREDENTIAL_ISSUER_SEED) {
    return { ran: false, reason: "CREDENTIAL_ISSUER_SEED is not set — queue left for a human (scripts/issue-queued-credentials.cjs) or a future run once it's set.", issuedToday: 0, cap, processed: [] };
  }
  const deadline = opts.deadlineMs ?? Date.now() + 30_000;

  let issuedToday = await issuedSinceMidnightUtc(prisma);
  if (issuedToday >= cap) {
    return { ran: true, reason: `daily cap (${cap}) already reached`, issuedToday, cap, processed: [] };
  }

  const queued = await prisma.credentialRequest.findMany({ where: { status: "queued" }, orderBy: { requestedAt: "asc" }, take: MAX_PER_RUN });
  const processed: AutoIssueOutcome[] = [];

  for (const q of queued) {
    if (Date.now() > deadline) break;
    if (issuedToday >= cap) {
      processed.push({ requestId: q.id, kind: q.kind, subject: q.subject, result: "skipped_cap", reason: `daily cap (${cap}) reached mid-run` });
      break;
    }

    try {
      let txHash: string;
      if (q.kind === "score") {
        const plan = await planScoreCredential(q.subject); // re-scores internally; throws ScoreNotEligibleError if it no longer clears the floor
        const res = await issueScoreCredential(plan);
        if (res.engineResult !== "tesSUCCESS") throw new Error(`engine result ${res.engineResult}`);
        txHash = res.txHash;
      } else if (q.kind === "mpt-declared") {
        const plan = planMptDeclaredCredential(q.subject);
        const res = await issueMptDeclaredCredential(plan);
        if (res.engineResult !== "tesSUCCESS") throw new Error(`engine result ${res.engineResult}`);
        txHash = res.txHash;
      } else if (q.kind === "screen-nomatch") {
        const plan = planScreenCredential(q.subject);
        const res = await issueScreenCredential(prisma, plan); // re-screens internally; throws ScreenCredListedError if listed now
        if (res.engineResult !== "tesSUCCESS") throw new Error(`engine result ${res.engineResult}`);
        txHash = res.txHash;
      } else if (q.kind === "domain-verified") {
        const plan = planDomainCredential(q.subject);
        const res = await issueDomainCredential(plan); // re-verifies internally; throws if the link no longer holds
        if (res.engineResult !== "tesSUCCESS") throw new Error(`engine result ${res.engineResult}`);
        txHash = res.txHash;
      } else {
        throw new Error(`unknown credential kind "${q.kind}"`);
      }

      await prisma.credentialRequest.update({ where: { id: q.id }, data: { status: "issued", issuedAt: new Date(), issuedTxHash: txHash } });
      issuedToday++;
      processed.push({ requestId: q.id, kind: q.kind, subject: q.subject, result: "issued", txHash });
    } catch (e) {
      // A tier change / re-listed / domain-no-longer-verified is a normal, expected refusal (the fact stopped
      // being true) -- not a system fault. Mark failed so the queue does not retry it forever; a fresh request
      // (e.g. the subject asks again once eligible) queues normally.
      const reason =
        e instanceof ScoreNotEligibleError ? `no longer eligible (score ${e.message})`
        : e instanceof ScreenCredListedError ? "address is listed as of the re-screen"
        : e instanceof Error ? e.message : String(e);
      await prisma.credentialRequest.update({ where: { id: q.id }, data: { status: "failed", note: reason.slice(0, 500) } }).catch(() => {});
      processed.push({ requestId: q.id, kind: q.kind, subject: q.subject, result: "failed", reason });
    }
  }

  return { ran: true, issuedToday, cap, processed };
}

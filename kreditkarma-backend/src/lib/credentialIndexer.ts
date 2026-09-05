// src/lib/credentialIndexer.ts
// The network-wide Credential census — a full ledger_data walk (type:
// "credential", confirmed short name from xrpl.org's ledger-entry-short-names
// reference), resumable across invocations. A single pass can require far
// more round trips than Credential objects actually exist: ledger_data's type
// filter still walks the WHOLE keyspace server-side, it just doesn't return
// non-matching leaves — so a bounded serverless invocation must persist its
// marker and pick up where it left off, not assume one run finishes.
//
// Read by /api/cron/index-credentials (bounded per invocation) and
// scripts/census-credentials.cjs (a human runs it to completion by hand).
// GET /api/credentials/issuer reads the table this writes, and must report
// coverage: "partial" whenever lastCompletedPassAt is null — see runPass()'s
// return shape.

import type { Client } from "xrpl";
import type { PrismaClient } from "@prisma/client";
import { connectMainnetOrThrow, validatedLedgerCloseTimeRipple } from "./credentials";

const CHECKPOINT_ID = "credential";
const PAGE_LIMIT = 200;

export interface PassProgress {
  status: "idle" | "running";
  passNumber: number;
  objectsSeenThisInvocation: number;
  pagesWalkedThisInvocation: number;
  completed: boolean; // this invocation reached the end of the ledger and closed out the pass
  lastCompletedPassAt: Date | null;
  lastCompletedPassNumber: number | null;
}

/**
 * Walk ledger_data (type=credential) for up to `budgetMs`, starting from the
 * persisted checkpoint, upserting rows and advancing the marker. Time-bounded
 * (not page-bounded) so it makes the most of whatever's left of a serverless
 * invocation's duration limit; call it repeatedly (cron, or a hand-run loop)
 * to complete a full pass.
 */
export async function runIndexerPass(
  prisma: PrismaClient,
  opts: { budgetMs?: number } = {}
): Promise<PassProgress> {
  const budgetMs = opts.budgetMs ?? 45_000; // leaves margin under Vercel Hobby's 60s maxDuration
  const startedAt = Date.now();

  let checkpoint = await prisma.indexerCheckpoint.findUnique({ where: { id: CHECKPOINT_ID } });
  if (!checkpoint) {
    checkpoint = await prisma.indexerCheckpoint.create({ data: { id: CHECKPOINT_ID } });
  }

  const isNewPass = checkpoint.status === "idle";
  const passNumber = isNewPass ? checkpoint.passNumber + 1 : checkpoint.passNumber;
  let marker: string | null = isNewPass ? null : checkpoint.marker;

  const client: Client = await connectMainnetOrThrow();
  let objectsSeen = 0;
  let pagesWalked = 0;
  let completed = false;

  try {
    const nowRipple = await validatedLedgerCloseTimeRipple(client);

    if (isNewPass) {
      await prisma.indexerCheckpoint.update({
        where: { id: CHECKPOINT_ID },
        data: { status: "running", passNumber, passStartedAt: new Date(), marker: null },
      });
    }

    while (Date.now() - startedAt < budgetMs) {
      const res = await client.request({
        command: "ledger_data",
        ledger_index: "validated",
        type: "credential",
        limit: PAGE_LIMIT,
        ...(marker ? { marker } : {}),
      } as unknown as Parameters<typeof client.request>[0]);
      const result = res.result as { state?: Record<string, unknown>[]; marker?: string };
      pagesWalked++;

      for (const node of result.state ?? []) {
        if (node.LedgerEntryType !== "Credential") continue; // defensive; type filter should already ensure this
        const flags = Number(node.Flags ?? 0);
        await prisma.indexedCredential.upsert({
          where: { objectIndex: String(node.index ?? "") },
          create: {
            objectIndex: String(node.index ?? ""),
            issuer: String(node.Issuer ?? ""),
            subject: String(node.Subject ?? ""),
            credentialType: String(node.CredentialType ?? ""),
            accepted: (flags & 0x00010000) !== 0,
            expirationRipple: typeof node.Expiration === "number" ? node.Expiration : null,
            uri: typeof node.URI === "string" ? node.URI : null,
            passNumber,
          },
          update: {
            accepted: (flags & 0x00010000) !== 0,
            expirationRipple: typeof node.Expiration === "number" ? node.Expiration : null,
            uri: typeof node.URI === "string" ? node.URI : null,
            passNumber,
          },
        });
        objectsSeen++;
      }

      marker = result.marker ?? null;
      if (!marker) {
        completed = true;
        break;
      }
    }

    if (completed) {
      // Anything not reconfirmed this pass no longer exists on the ledger
      // (accepted-then-expired-and-cleaned-up, or otherwise removed) — prune it.
      await prisma.indexedCredential.deleteMany({ where: { passNumber: { lt: passNumber } } });
      const completedAt = new Date();
      await prisma.indexerCheckpoint.update({
        where: { id: CHECKPOINT_ID },
        data: {
          status: "idle",
          marker: null,
          lastCompletedPassAt: completedAt,
          lastCompletedPassNumber: passNumber,
          lastLedgerCloseTime: nowRipple,
        },
      });
      return {
        status: "idle", passNumber, objectsSeenThisInvocation: objectsSeen, pagesWalkedThisInvocation: pagesWalked,
        completed: true, lastCompletedPassAt: completedAt, lastCompletedPassNumber: passNumber,
      };
    }

    await prisma.indexerCheckpoint.update({
      where: { id: CHECKPOINT_ID },
      data: { marker, lastLedgerCloseTime: nowRipple },
    });
    return {
      status: "running", passNumber, objectsSeenThisInvocation: objectsSeen, pagesWalkedThisInvocation: pagesWalked,
      completed: false, lastCompletedPassAt: checkpoint.lastCompletedPassAt, lastCompletedPassNumber: checkpoint.lastCompletedPassNumber,
    };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

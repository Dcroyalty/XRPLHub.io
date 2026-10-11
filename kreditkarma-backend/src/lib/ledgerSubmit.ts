// src/lib/ledgerSubmit.ts
// HALT-SAFE SUBMIT (2026-10-11) for every transaction the SERVER signs (anchors, credentials). Replaces the
// `client.autofill` + `client.submitAndWait` pattern, which during a ledger halt (e.g. 2025-02-04, 64 minutes) waits
// until Vercel kills the function — leaving a signed transaction queued that can still land after the ledger resumes
// while the next run builds and submits ANOTHER one.
//
//   1. PAUSE, don't submit, when the ledger isn't moving: the connected node's last validated ledger is older than
//      HALT_AGE_SEC (or it has none) → LedgerPausedError. Callers treat it as "not done, retry next run".
//   2. Sequence comes from the VALIDATED ledger, so a transaction stranded by an earlier halt (unvalidated, same
//      account) and this one share one Sequence number: at most ONE of them can ever apply. No double submission.
//   3. Bounded wait: poll the hash until validated (default 20 s), never hang. Not validated in time →
//      LedgerPendingError (NOT done; the next run retries with the validated Sequence, so it can't double up).
//      Validated ledger passed our LastLedgerSequence without it → LedgerExpiredError (never applied; safe to retry).
//   4. A transaction is only "done" when a VALIDATED ledger says so — the caller still checks engineResult.

import type { Client, Wallet } from "xrpl";
import { HALT_AGE_SEC } from "./xrplNodes";

export class LedgerPausedError extends Error { constructor(m: string) { super(m); this.name = "LedgerPausedError"; } }
export class LedgerPendingError extends Error { constructor(m: string, public hash: string) { super(m); this.name = "LedgerPendingError"; } }
export class LedgerExpiredError extends Error { constructor(m: string, public hash: string) { super(m); this.name = "LedgerExpiredError"; } }
/** True for the three "not done yet — retry next run" outcomes (and network/connection failures). */
export function isLedgerRetry(e: unknown): boolean {
  if (e instanceof LedgerPausedError || e instanceof LedgerPendingError || e instanceof LedgerExpiredError) return true;
  const m = e instanceof Error ? e.message : String(e);
  return /noCurrent|noNetwork|notSynced|tooBusy|timeout|timed out|ECONN|ENOTFOUND|ETIMEDOUT|socket|websocket|NotConnected|DisconnectedError|Connection/i.test(m);
}

export interface SubmitResult {
  /** Shaped like xrpl.js submitAndWait's response, so callers change one line. */
  result: { hash: string; meta: { TransactionResult: string }; validated: true; ledger_index: number; date?: number; close_time_iso?: string };
  prepared: Record<string, unknown>;
}

/** Throws LedgerPausedError if the connected node has no recent validated ledger. */
export async function assertLedgerMoving(client: Client): Promise<{ ledgerIndex: number }> {
  const si = await client.request({ command: "server_info" }).catch(() => null);
  const vl = (si?.result as { info?: { validated_ledger?: { seq?: number; age?: number } } } | undefined)?.info?.validated_ledger;
  if (!vl || typeof vl.seq !== "number") throw new LedgerPausedError("the XRP Ledger node has no validated ledger right now (halted or syncing) — paused, will retry");
  if (typeof vl.age === "number" && vl.age > HALT_AGE_SEC) throw new LedgerPausedError(`no new validated ledger for ${vl.age}s (XRP Ledger halted?) — paused, will retry`);
  return { ledgerIndex: vl.seq };
}

export async function submitValidated(client: Client, wallet: Wallet, tx: Record<string, unknown>, opts: { waitMs?: number } = {}): Promise<SubmitResult> {
  const { ledgerIndex } = await assertLedgerMoving(client);
  const prepared = (await client.autofill(tx as Parameters<Client["autofill"]>[0])) as unknown as Record<string, unknown>;
  if (prepared.TicketSequence == null) {
    const ai = await client.request({ command: "account_info", account: wallet.classicAddress, ledger_index: "validated" });
    prepared.Sequence = (ai.result.account_data as { Sequence: number }).Sequence;
  }
  prepared.LastLedgerSequence = ledgerIndex + 20;
  const signed = wallet.sign(prepared as Parameters<Wallet["sign"]>[0]);

  const sub = await client.request({ command: "submit", tx_blob: signed.tx_blob });
  const prelim = String((sub.result as { engine_result?: string }).engine_result ?? "");
  if (prelim.startsWith("tem") || (prelim.startsWith("tef") && prelim !== "tefPAST_SEQ")) {
    throw new Error(`rejected before reaching the ledger: ${prelim}`); // not applied, deterministic
  }
  if (prelim === "tefPAST_SEQ") throw new LedgerPendingError("an earlier transaction from this account used this sequence (it may have landed after a halt) — will re-read and retry", signed.hash);
  if (prelim.startsWith("tel") || (prelim.startsWith("ter") && prelim !== "terQUEUED")) throw new LedgerPausedError(`not accepted right now (${prelim}) — will retry`);

  const until = Date.now() + (opts.waitMs ?? 20_000);
  while (Date.now() < until) {
    await new Promise((s) => setTimeout(s, 1500));
    const t = await client.request({ command: "tx", transaction: signed.hash }).catch(() => null);
    const r = t?.result as { validated?: boolean; meta?: { TransactionResult?: string }; ledger_index?: number; date?: number; close_time_iso?: string } | undefined;
    if (r?.validated && r.meta?.TransactionResult) {
      return { result: { hash: signed.hash, meta: { TransactionResult: r.meta.TransactionResult }, validated: true, ledger_index: r.ledger_index ?? 0, date: r.date, close_time_iso: r.close_time_iso }, prepared };
    }
    const v = await client.request({ command: "ledger", ledger_index: "validated" }).catch(() => null);
    const vIdx = Number((v?.result as { ledger_index?: number } | undefined)?.ledger_index ?? 0);
    if (vIdx > (prepared.LastLedgerSequence as number)) throw new LedgerExpiredError(`not included before ledger ${prepared.LastLedgerSequence} — never applied, will retry`, signed.hash);
  }
  throw new LedgerPendingError(`submitted (${prelim}) but not validated within ${Math.round((opts.waitMs ?? 20_000) / 1000)}s — not marked done; the next run settles it`, signed.hash);
}

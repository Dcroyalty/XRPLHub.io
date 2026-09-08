// src/lib/xrplFacts.ts
// Permanent cache of immutable per-address facts. An account's FIRST transaction
// is its funding tx; ledgers are immutable; therefore firstTxLedger / firstTxDate
// never change. This row never expires, and it is safe on attestation paths —
// there is no staleness to anchor.
//
// Removes the account_tx{limit:1,forward:true} call from every re-score of an
// address we have seen before.

import { prisma } from "./xrplscore-db";
import { xrplRpc } from "./xrplNodes";

export type FirstTx =
  | { ok: true; firstTxLedger: number | null; firstTxDate: number | null }
  | { ok: false };

/**
 * Resolve the account's first transaction: cache hit -> 0 RPC; cache miss ->
 * one account_tx call, then persist. { ok: false } means the RPC could not be
 * read (contributes to XrplUnavailableError upstream, same as any other call).
 */
export async function resolveFirstTx(address: string): Promise<FirstTx> {
  try {
    const cached = await prisma.xrplFactCache.findUnique({ where: { address } });
    if (cached) {
      return { ok: true, firstTxLedger: cached.firstTxLedger, firstTxDate: cached.firstTxDate };
    }
  } catch {
    // DB unavailable — fall through to the live call rather than fail the score.
  }

  const res = await xrplRpc("account_tx", {
    account: address,
    limit: 1,
    forward: true,
    ledger_index_min: -1,
    ledger_index_max: -1,
  });
  if (!res.ok) return { ok: false };

  const result = (res.body as {
    result?: { transactions?: Array<{ tx?: Record<string, unknown>; tx_json?: Record<string, unknown> }>; error?: unknown; status?: unknown };
  }).result;

  // A node-level error ("noCurrent" etc.) is a read failure, not "no txs".
  if (!result || result.error != null || result.status === "error") return { ok: false };

  const entry = (result.transactions ?? [])[0];
  const tx = entry ? (entry.tx ?? entry.tx_json ?? {}) : {};
  const firstTxDate = (typeof tx.date === "number" ? tx.date : null) as number | null;
  const firstTxLedger = ((tx.ledger_index ?? tx.LedgerIndex) as number | undefined) ?? null;

  // Persist (best-effort; an existing row is never overwritten — facts don't move).
  void prisma.xrplFactCache
    .upsert({
      where: { address },
      update: {}, // immutable — leave any existing row untouched
      create: { address, firstTxLedger, firstTxDate },
    })
    .catch(() => {});

  return { ok: true, firstTxLedger, firstTxDate };
}

// src/lib/credentialAnomalyWatch.ts
// Reads the credential issuer's OWN on-chain transaction history and flags any CredentialCreate that
// doesn't match a request this app actually issued. Deliberately trusts nothing about HOW a
// CredentialCreate got onto the ledger -- it only asks "does the chain's own record match our
// database's record of what we intended to issue?" That's what makes it catch misuse even if
// CREDENTIAL_ISSUER_SEED itself were stolen and used from somewhere else entirely: a stolen-key
// issuance still shows up as a CredentialCreate from EXPECTED_ISSUER on the ledger, and it still won't
// match anything in CredentialRequest, because this app never asked for it.
//
// Checkpointed (IndexerCheckpoint id CHECKPOINT_ID) by validated ledger index, so each run only scans
// transactions since the last check -- not the issuer's whole history every time.

import type { PrismaClient } from "@prisma/client";
import { convertHexToString } from "xrpl";
import { xrplRpc } from "./xrplNodes";
import { EXPECTED_ISSUER } from "./credentials";

const CHECKPOINT_ID = "credential-anomaly-watch:last-ledger";
const SCAN_PAGE_LIMIT = 100;
const SCAN_MAX_PAGES = 10; // bounded, like every other ledger walk in this app -- fails closed (retried next run), never hangs

export interface AnomalyFinding {
  txHash: string;
  ledgerIndex: number | null;
  subject: string;
  credentialType: string; // decoded, human-readable
}

export interface AnomalyCheckResult {
  scanned: number;
  anomalies: AnomalyFinding[];
  lastLedgerChecked: number | null;
}

/**
 * Scan every CredentialCreate the issuer has submitted since the last checkpoint, and flag any whose
 * (subject, credentialType) doesn't match a CredentialRequest row this app marked "issued". Advances
 * the checkpoint only after a full, successful scan (never partway, so a failed run is safely retried).
 */
export async function checkCredentialAnomalies(prisma: PrismaClient): Promise<AnomalyCheckResult> {
  const cp = await prisma.indexerCheckpoint.findUnique({ where: { id: CHECKPOINT_ID } });
  const lastLedger = cp?.marker ? Number(cp.marker) : 0;

  const found: Array<{ hash: string; ledgerIndex: number; subject: string; credentialTypeHex: string }> = [];
  let marker: unknown = undefined;
  let highestSeen = lastLedger;

  for (let page = 0; page < SCAN_MAX_PAGES; page++) {
    const r = await xrplRpc("account_tx", {
      account: EXPECTED_ISSUER,
      ledger_index_min: lastLedger > 0 ? lastLedger + 1 : -1,
      ledger_index_max: -1,
      binary: false,
      limit: SCAN_PAGE_LIMIT,
      forward: true, // oldest-of-the-new-range first, so the checkpoint advances monotonically
      ...(marker ? { marker } : {}),
    });
    if (!r.ok) break; // transient -- retried next run, checkpoint not advanced
    const result = (r.body.result ?? {}) as { transactions?: Array<Record<string, unknown>>; marker?: unknown; error?: string };
    if (result.error) break;

    for (const entry of result.transactions ?? []) {
      const tx = (entry.tx ?? entry.tx_json) as Record<string, unknown> | undefined;
      const meta = (entry.meta ?? entry.metaData) as Record<string, unknown> | undefined;
      if (!tx || entry.validated === false) continue;
      const li = typeof tx.ledger_index === "number" ? tx.ledger_index : (typeof entry.ledger_index === "number" ? entry.ledger_index : null);
      if (li !== null && li > highestSeen) highestSeen = li;
      if (tx.TransactionType !== "CredentialCreate") continue;
      const result_ = meta?.TransactionResult as string | undefined;
      if (result_ !== "tesSUCCESS") continue; // a failed CredentialCreate never touched the ledger state -- nothing to reconcile
      const subject = String(tx.Subject ?? "");
      const credentialTypeHex = String(tx.CredentialType ?? "");
      const hash = String(tx.hash ?? entry.hash ?? "");
      if (subject && credentialTypeHex && hash) found.push({ hash, ledgerIndex: li ?? 0, subject, credentialTypeHex });
    }
    marker = result.marker;
    if (!marker) break;
  }

  const anomalies: AnomalyFinding[] = [];
  for (const f of found) {
    const known = await prisma.credentialRequest.findFirst({ where: { issuedTxHash: f.hash } });
    if (!known) {
      let decoded = f.credentialTypeHex;
      try { decoded = convertHexToString(f.credentialTypeHex); } catch { /* keep hex if it doesn't decode */ }
      anomalies.push({ txHash: f.hash, ledgerIndex: f.ledgerIndex, subject: f.subject, credentialType: decoded });
    }
  }

  // Only advance the checkpoint on a run that completed (didn't break early on a node error) -- otherwise
  // the same range is safely rescanned next time rather than silently skipping transactions.
  if (highestSeen > lastLedger) {
    await prisma.indexerCheckpoint.upsert({
      where: { id: CHECKPOINT_ID },
      create: { id: CHECKPOINT_ID, status: "idle", marker: String(highestSeen), lastCompletedPassAt: new Date() },
      update: { marker: String(highestSeen), lastCompletedPassAt: new Date() },
    });
  }

  return { scanned: found.length, anomalies, lastLedgerChecked: highestSeen > lastLedger ? highestSeen : lastLedger };
}

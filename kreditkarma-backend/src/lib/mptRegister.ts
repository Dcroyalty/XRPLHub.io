// src/lib/mptRegister.ts
// When someone issues an MPT through XRPLHub, put it in our registry IMMEDIATELY
// — don't wait for the ledger_data walk to reach a brand-new issuer or for
// Bithomp to index it. Called fire-and-forget from /api/execute/verify once the
// MPTokenIssuanceCreate reaches tesSUCCESS.
//
// It (a) writes the IndexedMPT row straight from the transaction's CreatedNode,
// (b) ensures the issuer is a known issuer so the daily cron rescopes/rescores
// it, and (c) returns the real 48-hex MPTokenIssuanceID for the delivery
// response. The next cron pass re-confirms everything.

import type { PrismaClient } from "@prisma/client";
import { mptRowFromLedgerNode, mptSearchText, deriveMptIssuanceId } from "./mptIndex";

interface MetaNode {
  CreatedNode?: {
    LedgerEntryType?: string;
    LedgerIndex?: string;
    NewFields?: Record<string, unknown>;
  };
}

export interface RegisterResult {
  registered: boolean;
  issuanceId: string | null;
  detail: string;
}

/** `tx` is the full `result` object from a `tx` RPC call (must be validated). */
export async function registerNewMptIssuance(
  prisma: PrismaClient,
  issuer: string,
  tx: Record<string, unknown>
): Promise<RegisterResult> {
  try {
    const meta = tx.meta as { AffectedNodes?: MetaNode[]; TransactionResult?: string } | undefined;
    if (meta?.TransactionResult !== "tesSUCCESS") {
      return { registered: false, issuanceId: null, detail: "transaction not tesSUCCESS" };
    }
    const created = (meta.AffectedNodes ?? [])
      .map((n) => n.CreatedNode)
      .find((c) => c?.LedgerEntryType === "MPTokenIssuance");
    if (!created?.NewFields) {
      return { registered: false, issuanceId: null, detail: "no MPTokenIssuance CreatedNode in tx metadata" };
    }

    const nf = created.NewFields;
    const sequence = typeof nf.Sequence === "number" ? nf.Sequence : Number(tx.Sequence ?? 0) || null;
    const nodeForShape: Record<string, unknown> = {
      Issuer: String(nf.Issuer ?? issuer),
      Sequence: sequence,
      MPTokenMetadata: nf.MPTokenMetadata,
      AssetScale: nf.AssetScale ?? 0,
      MaximumAmount: nf.MaximumAmount,
      OutstandingAmount: nf.OutstandingAmount ?? "0",
      TransferFee: nf.TransferFee ?? 0,
      Flags: nf.Flags ?? 0,
      mpt_issuance_id:
        sequence != null ? deriveMptIssuanceId(sequence, String(nf.Issuer ?? issuer)) : undefined,
    };
    const row = mptRowFromLedgerNode(nodeForShape);
    if (!/^[0-9A-F]{48}$/.test(row.issuanceId)) {
      return { registered: false, issuanceId: null, detail: `could not derive a valid issuanceId (${row.issuanceId})` };
    }

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
      sources: "xrplhub",
      ledgerIndex: Number(tx.ledger_index ?? 0) || null,
    };
    await prisma.indexedMPT.upsert({
      where: { issuanceId: row.issuanceId },
      create: { issuanceId: row.issuanceId, ...common },
      update: common,
    });

    // Make the issuer a known issuer so the cron round-robin picks it up and
    // computes its aggregate + XRPLScore on the next pass.
    await prisma.indexedMptIssuer
      .upsert({
        where: { issuer: row.issuer },
        update: {},
        create: { issuer: row.issuer, mptCount: 1, issuanceIdsHash: null },
      })
      .catch(() => {});

    return { registered: true, issuanceId: row.issuanceId, detail: "indexed from the issuance transaction" };
  } catch (e) {
    return {
      registered: false,
      issuanceId: null,
      detail: e instanceof Error ? e.message : "registration failed",
    };
  }
}

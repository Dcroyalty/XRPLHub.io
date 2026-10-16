// src/lib/lendingFacts.ts — read one vault (or one broker) and everything a risk grade needs, from the ledger.
//
// The RPC function is injected, so the same code runs against mainnet (XRPLHub's node pool, uxus's pool) and
// Devnet (the test script). Verified against XRPL Devnet on 2026-10-16:
//   vault owner  --account_objects type loan_broker-->  its LoanBrokers (filtered by VaultID)
//   broker's pseudo-account  --account_objects type loan-->  its Loans
//   vault ShareMPTID  --ledger_entry mpt_issuance-->  OutstandingAmount (shares outstanding)
//   pseudo-account  --account_tx forward, limit 1-->  creation date
//   ledger_entry at an older ledger_index  -->  the vault 30 days ago (needs a full-history node; optional)
//
// A copy of this file lives in the uxus repo (cryptorisk-api: lib/xrpl-lending/facts.ts). Change both together.

import type { BrokerFacts, LoanFacts, VaultFacts } from "./lendingGrade";

/** One JSON-RPC call. Returns `result`, or null when no node answered. */
export type LedgerRpc = (method: string, params: Record<string, unknown>) => Promise<Record<string, any> | null>;

export const RIPPLE_EPOCH = 946_684_800;
const LSF_LOAN_DEFAULT = 0x00010000;
const LSF_LOAN_IMPAIRED = 0x00020000;
const LSF_VAULT_PRIVATE = 0x00010000;
const TENTH_BP_TO_PCT = 1 / 1000; // ledger rates are 1/10 basis points: 100000 = 100%
const YIELD_LOOKBACK_DAYS = 30;
const AVG_LEDGER_SECONDS = 3.9;

export const LENDING_TX_TYPES = new Set([
  "VaultCreate", "VaultSet", "VaultDelete", "VaultDeposit", "VaultWithdraw", "VaultClawback",
  "LoanBrokerSet", "LoanBrokerDelete", "LoanBrokerCoverDeposit", "LoanBrokerCoverWithdraw", "LoanBrokerCoverClawback",
  "LoanSet", "LoanDelete", "LoanManage", "LoanPay",
]);

export const num = (v: unknown): number => {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : 0;
  return Number.isFinite(n) ? n : 0;
};
const isoFromRipple = (t: unknown) => (typeof t === "number" && t > 0 ? new Date((t + RIPPLE_EPOCH) * 1000).toISOString() : null);

function hexCurrency(c: string): string {
  if (c.length !== 40) return c;
  const s = Buffer.from(c, "hex").toString("utf8").replace(/\0+$/, "");
  return /^[\x20-\x7e]+$/.test(s) ? s : c;
}
export function assetLabel(asset: unknown): string {
  const a = (asset ?? {}) as { currency?: string; issuer?: string; mpt_issuance_id?: string };
  if (a.mpt_issuance_id) return `MPT ${a.mpt_issuance_id.slice(0, 12)}…`;
  if (!a.currency || a.currency === "XRP") return "XRP";
  return a.issuer ? `${hexCurrency(a.currency)} (${a.issuer.slice(0, 6)}…)` : hexCurrency(a.currency);
}

async function ledgerEntry(rpc: LedgerRpc, params: Record<string, unknown>, ledgerIndex: number | "validated" = "validated") {
  const r = await rpc("ledger_entry", { ...params, ledger_index: ledgerIndex });
  return r && r.node && !r.error ? (r.node as Record<string, any>) : null;
}

async function accountObjects(rpc: LedgerRpc, account: string, type: string): Promise<Record<string, any>[]> {
  const out: Record<string, any>[] = [];
  let marker: unknown;
  for (let page = 0; page < 20; page++) {
    const r = await rpc("account_objects", { account, type, ledger_index: "validated", limit: 400, ...(marker ? { marker } : {}) });
    if (!r || r.error) {
      if (page === 0 && r?.error === "actNotFound") return out;
      throw new Error(`account_objects ${type} for ${account}: ${r?.error ?? "no node answered"}`);
    }
    out.push(...((r.account_objects as Record<string, any>[]) ?? []));
    marker = r.marker;
    if (!marker) break;
  }
  return out;
}

/** Date of an account's first transaction (a pseudo-account's first tx is the one that created it). */
export async function createdAt(rpc: LedgerRpc, account: string): Promise<string | null> {
  const r = await rpc("account_tx", { account, forward: true, limit: 1, ledger_index_min: -1, ledger_index_max: -1 });
  const t = (r?.transactions as Record<string, any>[] | undefined)?.[0];
  if (!t) return null;
  return t.close_time_iso ?? isoFromRipple((t.tx_json ?? t.tx)?.date);
}

export function loanFacts(l: Record<string, any>, nowMs: number): LoanFacts {
  const flags = num(l.Flags);
  const defaulted = (flags & LSF_LOAN_DEFAULT) !== 0;
  const impaired = (flags & LSF_LOAN_IMPAIRED) !== 0;
  const due = typeof l.NextPaymentDueDate === "number" && l.NextPaymentDueDate > 0 ? (l.NextPaymentDueDate + RIPPLE_EPOCH) * 1000 : null;
  const late = !defaulted && due != null && nowMs > due && num(l.PaymentRemaining) > 0;
  return {
    id: String(l.index),
    borrower: String(l.Borrower),
    principalOutstanding: num(l.PrincipalOutstanding),
    totalValueOutstanding: num(l.TotalValueOutstanding),
    defaulted,
    impaired,
    late,
    daysLate: late && due ? Math.floor((nowMs - due) / 86_400_000) : 0,
    interestRatePct: num(l.InterestRate) * TENTH_BP_TO_PCT,
    nextPaymentDue: due ? new Date(due).toISOString() : null,
  };
}

export function brokerFactsFrom(b: Record<string, any>, loans: Record<string, any>[], created: string | null, nowMs: number): BrokerFacts {
  return {
    id: String(b.index),
    account: String(b.Account),
    owner: String(b.Owner),
    vaultId: String(b.VaultID),
    debtTotal: num(b.DebtTotal),
    debtMaximum: num(b.DebtMaximum),
    coverAvailable: num(b.CoverAvailable),
    coverRateMinimumPct: num(b.CoverRateMinimum) * TENTH_BP_TO_PCT,
    coverRateLiquidationPct: num(b.CoverRateLiquidation) * TENTH_BP_TO_PCT,
    managementFeePct: num(b.ManagementFeeRate) * TENTH_BP_TO_PCT,
    activeLoans: num(b.OwnerCount),
    loansEver: Math.max(0, num(b.LoanSequence) - 1),
    createdAt: created,
    loans: loans.map((l) => loanFacts(l, nowMs)),
  };
}

/** Everything about one broker. Null if it doesn't exist. */
export async function readBroker(rpc: LedgerRpc, brokerId: string, nowMs = Date.now()): Promise<{ raw: Record<string, any>; loansRaw: Record<string, any>[]; facts: BrokerFacts } | null> {
  const raw = await ledgerEntry(rpc, { index: brokerId });
  if (!raw || raw.LedgerEntryType !== "LoanBroker") return null;
  const [loansRaw, created] = await Promise.all([accountObjects(rpc, String(raw.Account), "loan"), createdAt(rpc, String(raw.Account))]);
  return { raw, loansRaw, facts: brokerFactsFrom(raw, loansRaw, created, nowMs) };
}

async function shareValue(rpc: LedgerRpc, vault: Record<string, any>, ledgerIndex: number | "validated" = "validated"): Promise<{ shares: number | null; value: number | null }> {
  const iss = await ledgerEntry(rpc, { mpt_issuance: vault.ShareMPTID }, ledgerIndex);
  const shares = iss ? num(iss.OutstandingAmount) : null;
  const assets = num(vault.AssetsTotal) - num(vault.LossUnrealized);
  return { shares, value: shares && shares > 0 ? assets / shares : null };
}

/** The vault, its value per share now and ~30 days ago, and each broker lending from it with its loans. */
export async function readVault(
  rpc: LedgerRpc,
  vaultId: string,
  nowMs = Date.now()
): Promise<{ raw: Record<string, any>; brokersRaw: Record<string, any>[]; loansRaw: Record<string, Record<string, any>[]>; facts: VaultFacts } | null> {
  const raw = await ledgerEntry(rpc, { index: vaultId });
  if (!raw || raw.LedgerEntryType !== "Vault") return null;
  const [owned, created, now, current] = await Promise.all([
    accountObjects(rpc, String(raw.Owner), "loan_broker"),
    createdAt(rpc, String(raw.Account)),
    shareValue(rpc, raw),
    rpc("ledger", { ledger_index: "validated" }),
  ]);
  const brokersRaw = owned.filter((b) => b.VaultID === vaultId);
  const loansRaw: Record<string, Record<string, any>[]> = {};
  const brokerCreated: Record<string, string | null> = {};
  await Promise.all(
    brokersRaw.map(async (b) => {
      const [l, c] = await Promise.all([accountObjects(rpc, String(b.Account), "loan"), createdAt(rpc, String(b.Account))]);
      loansRaw[String(b.index)] = l;
      brokerCreated[String(b.index)] = c;
    })
  );

  // Value of one share ~30 days ago, read from an older ledger. Needs a full-history node; skipped otherwise.
  let past: VaultFacts["shareValuePast"] = null;
  const curIndex = num(current?.ledger_index ?? current?.ledger?.ledger_index);
  const curClose = num(current?.ledger?.close_time);
  if (curIndex > 0 && created && nowMs - Date.parse(created) > 8 * 86_400_000) {
    const ageDays = Math.min(YIELD_LOOKBACK_DAYS, (nowMs - Date.parse(created)) / 86_400_000 - 1);
    const pastIndex = Math.max(1, Math.round(curIndex - (ageDays * 86_400) / AVG_LEDGER_SECONDS));
    const [oldVault, oldLedger] = await Promise.all([ledgerEntry(rpc, { index: vaultId }, pastIndex), rpc("ledger", { ledger_index: pastIndex })]);
    if (oldVault) {
      const v = await shareValue(rpc, oldVault, pastIndex);
      const oldClose = num(oldLedger?.ledger?.close_time);
      if (v.value && oldClose && curClose) past = { value: v.value, daysAgo: Math.round(((curClose - oldClose) / 86_400) * 10) / 10 };
    }
  }

  const facts: VaultFacts = {
    id: String(raw.index),
    account: String(raw.Account),
    owner: String(raw.Owner),
    assetLabel: assetLabel(raw.Asset),
    assetsTotal: num(raw.AssetsTotal),
    assetsAvailable: num(raw.AssetsAvailable),
    assetsMaximum: num(raw.AssetsMaximum),
    lossUnrealized: num(raw.LossUnrealized),
    sharesOutstanding: now.shares,
    isPrivate: (num(raw.Flags) & LSF_VAULT_PRIVATE) !== 0,
    createdAt: created,
    shareValueNow: now.value,
    shareValuePast: past,
    brokers: brokersRaw.map((b) => brokerFactsFrom(b, loansRaw[String(b.index)] ?? [], brokerCreated[String(b.index)] ?? null, nowMs)),
  };
  return { raw, brokersRaw, loansRaw, facts };
}

/**
 * Lending transactions that touched a pseudo-account after `sinceLedger`, oldest first. `throughLedger` is how
 * far the read got: the next call should pass it as `sinceLedger`. When pages run out before the end, it stops
 * one ledger short of the last one read, so nothing in a half-read ledger is skipped (duplicates are harmless).
 */
export async function lendingTxs(rpc: LedgerRpc, account: string, sinceLedger: number, maxPages = 5): Promise<{ txs: Record<string, any>[]; throughLedger: number }> {
  const out: Record<string, any>[] = [];
  let marker: unknown;
  let through = sinceLedger;
  for (let page = 0; page < maxPages; page++) {
    const r = await rpc("account_tx", { account, forward: true, ledger_index_min: sinceLedger > 0 ? sinceLedger + 1 : -1, ledger_index_max: -1, limit: 200, ...(marker ? { marker } : {}) });
    if (!r || r.error) return { txs: out, throughLedger: through };
    let lastSeen = through;
    for (const t of (r.transactions as Record<string, any>[]) ?? []) {
      const tx = t.tx_json ?? t.tx;
      const li = num(t.ledger_index ?? tx?.ledger_index);
      if (li > lastSeen) lastSeen = li;
      if (tx && LENDING_TX_TYPES.has(tx.TransactionType)) out.push({ ...t, tx });
    }
    marker = r.marker;
    if (!marker) return { txs: out, throughLedger: Math.max(through, num(r.ledger_index_max), lastSeen) };
    through = Math.max(through, lastSeen - 1);
  }
  return { txs: out, throughLedger: through };
}

// src/lib/lendingLedger.ts
// XRPL mainnet reads for XLS-66 cross-broker lending exposure.
//
// XLS-66 links every Loan into the BORROWER's owner directory (the borrower is
// the "main Owner" and pays its reserve), so one account_objects call on the
// borrower returns every loan across every broker. The loan's currency is not on
// the Loan object — it is Loan.LoanBrokerID -> LoanBroker.VaultID -> Vault.Asset.
//
// The amendment is NOT active on mainnet yet. The gate reads the on-ledger
// Amendments object (see ./amendments) and checks for LendingProtocol; when it
// flips, this endpoint serves with no redeploy.

import { XRPL_NODES } from "./xrplscore";
import { getAmendmentStatus, _resetAmendmentsForTest } from "./amendments";

// SHA512-Half("LendingProtocol"). Verified against the known AMM amendment id.
export const LENDING_PROTOCOL_AMENDMENT_ID =
  "565B90CA1AB2B9D42208ED10884188C64F9E19083DECB9634AAF06EB03299509";

const RIPPLE_EPOCH_OFFSET = 946_684_800;

type RpcResult = Record<string, unknown>;

/** One JSON-RPC call, tried across the hardcoded MAINNET nodes. */
async function rpc(method: string, params: object): Promise<RpcResult | null> {
  for (const url of XRPL_NODES) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method, params: [params] }),
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) continue;
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("json")) continue;
      const j = (await res.json()) as { result?: RpcResult };
      if (j?.result) return j.result;
    } catch {
      /* next node */
    }
  }
  return null;
}

// ── Amendment gate ───────────────────────────────────────────────────────────
// Backed by the shared tri-state gate in ./amendments (one Amendments-object read
// for every amendment, shared node rotation, "active" remembered forever). Lending
// wants to FAIL CLOSED, so anything but a confirmed "active" — including "unknown"
// when the ledger can't be read — is treated as not active (a clean no-op).

/** Test-only: clear the amendment-status cache. Not used in production paths. */
export function _resetAmendmentCacheForTest(): void {
  _resetAmendmentsForTest();
}

export async function lendingProtocolActive(): Promise<boolean> {
  return (await getAmendmentStatus("LendingProtocol")).state === "active";
}

export interface ValidatedLedger {
  index: number;
  closeAt: Date | null;
}

export async function validatedLedger(): Promise<ValidatedLedger> {
  const r = await rpc("ledger", { ledger_index: "validated" });
  const idx = Number(
    (r?.ledger_index as number) ?? (r?.ledger as { ledger_index?: number | string })?.ledger_index ?? 0
  );
  const closeSec = Number((r?.ledger as { close_time?: number })?.close_time ?? 0);
  return {
    index: Number.isFinite(idx) && idx > 0 ? idx : 0,
    closeAt: closeSec > 0 ? new Date((closeSec + RIPPLE_EPOCH_OFFSET) * 1000) : null,
  };
}

// ── Raw ledger objects ──────────────────────────────────────────────────────

export interface RawLoan {
  index: string;
  LoanBrokerID: string;
  Borrower: string;
  LoanSequence: number;
  Flags: number;
  PrincipalOutstanding: string;
  TotalValueOutstanding: string;
  ManagementFeeOutstanding?: string;
  InterestRate: number;
  LateInterestRate?: number;
  CloseInterestRate?: number;
  StartDate: number;
  NextPaymentDueDate: number;
  PreviousPaymentDueDate?: number;
  PaymentInterval: number;
  PaymentRemaining: number;
  GracePeriod: number;
  PeriodicPayment?: string;
  LoanScale?: number;
}

export interface RawBroker {
  index: string;
  Owner: string;
  Account: string; // pseudo-account
  VaultID: string;
  DebtTotal?: string;
  DebtMaximum?: string;
  CoverAvailable?: string;
  CoverRateMinimum?: number;
  CoverRateLiquidation?: number;
  ManagementFeeRate?: number;
}

export type ResolvedAsset =
  | { kind: "XRP"; key: "XRP" }
  | { kind: "IOU"; key: string; currency: string; issuer: string }
  | { kind: "MPT"; key: string; mptIssuanceId: string }
  | { kind: "unknown"; key: "unknown" };

/** Every Loan object in the borrower's owner directory (all brokers). Paginated. */
export async function fetchBorrowerLoans(borrower: string): Promise<RawLoan[]> {
  const loans: RawLoan[] = [];
  let marker: unknown = undefined;
  for (let page = 0; page < 20; page++) {
    const params: RpcResult = { account: borrower, ledger_index: "validated", limit: 200, type: "loan" };
    if (marker) params.marker = marker;
    let r = await rpc("account_objects", params);
    // Fallback: a node that doesn't know the "loan" type filter — page unfiltered.
    if (r && Array.isArray(r.account_objects) === false && !("account_objects" in r)) r = null;
    if (!r) {
      delete params.type;
      r = await rpc("account_objects", params);
    }
    if (!r) break;
    const objs = (r.account_objects as Array<Record<string, unknown>>) ?? [];
    for (const o of objs) {
      if (o.LedgerEntryType !== "Loan") continue;
      loans.push({
        index: String(o.index ?? o.LedgerIndex ?? ""),
        LoanBrokerID: String(o.LoanBrokerID ?? ""),
        Borrower: String(o.Borrower ?? ""),
        LoanSequence: Number(o.LoanSequence ?? 0),
        Flags: Number(o.Flags ?? 0),
        PrincipalOutstanding: String(o.PrincipalOutstanding ?? "0"),
        TotalValueOutstanding: String(o.TotalValueOutstanding ?? "0"),
        ManagementFeeOutstanding: o.ManagementFeeOutstanding != null ? String(o.ManagementFeeOutstanding) : undefined,
        InterestRate: Number(o.InterestRate ?? 0),
        LateInterestRate: o.LateInterestRate != null ? Number(o.LateInterestRate) : undefined,
        CloseInterestRate: o.CloseInterestRate != null ? Number(o.CloseInterestRate) : undefined,
        StartDate: Number(o.StartDate ?? 0),
        NextPaymentDueDate: Number(o.NextPaymentDueDate ?? 0),
        PreviousPaymentDueDate: o.PreviousPaymentDueDate != null ? Number(o.PreviousPaymentDueDate) : undefined,
        PaymentInterval: Number(o.PaymentInterval ?? 0),
        PaymentRemaining: Number(o.PaymentRemaining ?? 0),
        GracePeriod: Number(o.GracePeriod ?? 0),
        PeriodicPayment: o.PeriodicPayment != null ? String(o.PeriodicPayment) : undefined,
        LoanScale: o.LoanScale != null ? Number(o.LoanScale) : undefined,
      });
    }
    marker = r.marker;
    if (!marker) break;
  }
  return loans;
}

export async function fetchBroker(loanBrokerId: string): Promise<RawBroker | null> {
  const r = await rpc("ledger_entry", { index: loanBrokerId, ledger_index: "validated" });
  const n = r?.node as Record<string, unknown> | undefined;
  if (!n || n.LedgerEntryType !== "LoanBroker") return null;
  return {
    index: String(n.index ?? loanBrokerId),
    Owner: String(n.Owner ?? ""),
    Account: String(n.Account ?? ""),
    VaultID: String(n.VaultID ?? ""),
    DebtTotal: n.DebtTotal != null ? String(n.DebtTotal) : undefined,
    DebtMaximum: n.DebtMaximum != null ? String(n.DebtMaximum) : undefined,
    CoverAvailable: n.CoverAvailable != null ? String(n.CoverAvailable) : undefined,
    CoverRateMinimum: n.CoverRateMinimum != null ? Number(n.CoverRateMinimum) : undefined,
    CoverRateLiquidation: n.CoverRateLiquidation != null ? Number(n.CoverRateLiquidation) : undefined,
    ManagementFeeRate: n.ManagementFeeRate != null ? Number(n.ManagementFeeRate) : undefined,
  };
}

export async function fetchVaultAsset(vaultId: string): Promise<ResolvedAsset> {
  const r = await rpc("ledger_entry", { index: vaultId, ledger_index: "validated" });
  const n = r?.node as Record<string, unknown> | undefined;
  if (!n || n.LedgerEntryType !== "Vault") return { kind: "unknown", key: "unknown" };
  const asset = n.Asset as Record<string, unknown> | string | undefined;
  if (asset === undefined) return { kind: "unknown", key: "unknown" };
  if (typeof asset === "string" || (asset as { currency?: string })?.currency === "XRP") {
    return { kind: "XRP", key: "XRP" };
  }
  const a = asset as { currency?: string; issuer?: string; mpt_issuance_id?: string };
  if (a.mpt_issuance_id) return { kind: "MPT", key: `MPT:${a.mpt_issuance_id}`, mptIssuanceId: a.mpt_issuance_id };
  if (a.currency && a.issuer) {
    return { kind: "IOU", key: `${a.currency}.${a.issuer}`, currency: a.currency, issuer: a.issuer };
  }
  return { kind: "unknown", key: "unknown" };
}

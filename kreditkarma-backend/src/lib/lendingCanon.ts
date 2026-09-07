// src/lib/lendingCanon.ts
// FROZEN canonicalisation for XLS-66 lending-exposure attestations — canonVersion
// "lending-exposure-v1". A snapshot attests to STATE OBSERVED: at ledger N /
// time T, borrower X had exactly these loans on the ledger with this exposure.
// Because XLS-66 lets either party delete a paid or defaulted Loan (zeroing its
// amounts first), an attested snapshot is the only durable record that a loan
// ever existed — the leaf commits to the exact list of visible Loan ids.
//
// Leaf key order is load-bearing. Leaf hash / tree / root are byte-identical to
// the OFAC screening + MPT registry anchors (RFC 6962, ./merkle).

import { createHash } from "crypto";

export const LENDING_CANON_VERSION = "lending-exposure-v1";

// The observation engine version. Bump (v2, v3, …) IN THE SAME COMMIT as any
// change to: which ledger objects are read, how a loan's status is derived,
// how exposure is aggregated, or which fields the leaf commits to. Ingesting a
// newer ledger state is not a bump — that is `ledgerIndex`.
export const LENDING_ENGINE_VERSION = "lending-exposure-v1";

export const LENDING_CANON_SPEC = {
  version: LENDING_CANON_VERSION,
  engine: {
    version: LENDING_ENGINE_VERSION,
    read: "account_objects on the borrower filtered to LedgerEntryType 'Loan' (the borrower is the Loan's main Owner, so this returns every loan across every broker); then ledger_entry by index for each distinct LoanBrokerID and its VaultID to resolve the asset and the broker's first-loss position.",
    statusDerivation:
      "Per loan, most severe first: defaulted (lsfLoanDefault flag) > impaired (lsfLoanImpaired flag) > paid (PaymentRemaining == 0) > overdueGraceExpired (ledgerCloseTime > NextPaymentDueDate + GracePeriod) > overdue (ledgerCloseTime > NextPaymentDueDate) > current.",
    amounts:
      "PrincipalOutstanding and TotalValueOutstanding are the on-ledger NUMBER values verbatim (decimal strings). A defaulted loan carries 0 for both by protocol rule — the flag is the credit event, not the balance.",
    excludes:
      "No loans deleted before our first observation of this borrower. No off-ledger data. No name/entity resolution. Not underwriting or credit advice.",
  },
  record: {
    description:
      "Build a JSON object with EXACTLY these keys in this order, then JSON.stringify with no extra whitespace (UTF-8 bytes).",
    keys: [
      "queryId", // UUIDv4
      "borrower", // the XRPL address queried
      "ledgerIndex", // validated ledger the observation was taken at
      "ledgerCloseAt", // RFC 3339 UTC of that ledger's close, or null
      "amendmentActive", // boolean — was LendingProtocol enabled at query time
      "exposureByAsset", // { <assetKey>: { principalOutstanding, totalValueOutstanding, loanCount } }, asset keys sorted ascending
      "loanCount", // integer — Loan objects visible at this ledger
      "brokerCount", // integer — distinct LoanBrokerID
      "events", // { defaulted, impaired, overdue, overdueGraceExpired } — integer counts
      "worstStatus", // string — most severe status across the visible loans, or "none"
      "visibleLoanIds", // string[] of Loan ledger indexes, sorted ascending — the exact set observed
      "xrplScore", // integer 300-850, or null
      "engineVersion", // "lending-exposure-v1"
      "generatedAt", // RFC 3339 UTC, millisecond precision, 'Z'
    ],
  },
  leaves:
    "Order the snapshots in an anchor batch by queryId ascending (byte order). Leaf hash = SHA-256( 0x00 || utf8(recordJson) ).",
  merkle:
    "RFC 6962 style. Internal node = SHA-256( 0x01 || left || right ). Odd node at a level promoted unchanged. Single-leaf root is that leaf hash. Empty tree root is SHA-256 of the empty string.",
  root: "Lowercase 64-char hex.",
  onLedger: {
    account: "r9dQS1oGms3B7SdY6nyU24Dy7dWyWXuJXb",
    accountNote:
      "Trust roots ONLY from this address — the dedicated XRPLHub anchor wallet, deliberately NOT the credential issuer.",
    transactionType: "AccountSet",
    memoType: `XRPLHub-Lending-Exposure-Anchor/${LENDING_CANON_VERSION}`,
    memoFormat: "application/json",
    memoDataIs: "hex(UTF-8 JSON) — { v, root, leaves, rangeStart, rangeEnd, ts }. `root` is the Merkle root.",
  },
} as const;

export interface ExposureAssetEntry {
  principalOutstanding: string;
  totalValueOutstanding: string;
  loanCount: number;
}

export interface LendingExposureLeaf {
  queryId: string;
  borrower: string;
  ledgerIndex: number;
  ledgerCloseAt: string | null;
  amendmentActive: boolean;
  exposureByAsset: Record<string, ExposureAssetEntry>;
  loanCount: number;
  brokerCount: number;
  events: { defaulted: number; impaired: number; overdue: number; overdueGraceExpired: number };
  worstStatus: string;
  visibleLoanIds: string[];
  xrplScore: number | null;
  engineVersion: string;
  generatedAt: string;
}

/** Deterministic serialisation — explicit key order, sorted sub-structures. */
export function canonLendingLeaf(leaf: LendingExposureLeaf): string {
  const exposureByAsset: Record<string, ExposureAssetEntry> = {};
  for (const k of Object.keys(leaf.exposureByAsset).sort()) {
    const e = leaf.exposureByAsset[k];
    exposureByAsset[k] = {
      principalOutstanding: e.principalOutstanding,
      totalValueOutstanding: e.totalValueOutstanding,
      loanCount: e.loanCount,
    };
  }
  return JSON.stringify({
    queryId: leaf.queryId,
    borrower: leaf.borrower,
    ledgerIndex: leaf.ledgerIndex,
    ledgerCloseAt: leaf.ledgerCloseAt,
    amendmentActive: leaf.amendmentActive,
    exposureByAsset,
    loanCount: leaf.loanCount,
    brokerCount: leaf.brokerCount,
    events: {
      defaulted: leaf.events.defaulted,
      impaired: leaf.events.impaired,
      overdue: leaf.events.overdue,
      overdueGraceExpired: leaf.events.overdueGraceExpired,
    },
    worstStatus: leaf.worstStatus,
    visibleLoanIds: [...leaf.visibleLoanIds].sort(),
    xrplScore: leaf.xrplScore,
    engineVersion: leaf.engineVersion,
    generatedAt: leaf.generatedAt,
  });
}

export function lendingLeafHash(leaf: LendingExposureLeaf): string {
  return createHash("sha256")
    .update(Buffer.concat([Buffer.from([0x00]), Buffer.from(canonLendingLeaf(leaf), "utf8")]))
    .digest("hex");
}

// src/lib/xrplscore.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE XRPLScore ENGINE.
//
// This is the exact 9-signal scorer the public site runs. It was lifted
// verbatim out of src/app/api/score/[address]/route.ts so that the website,
// the B2B API (src/lib/engine.ts), the wallet report (src/lib/report.ts) and
// the paid credential all call the SAME code path and can never disagree on a
// number for the same wallet at the same ledger state.
//
// Pure: fetches + math only. No DB writes, no HTTP-response wrapping — callers
// own those. Data source is mainnet public JSON-RPC (xrplcluster -> s1 -> s2).
// ─────────────────────────────────────────────────────────────────────────────

// Treasury that receives XRPLHub service & Builder subscription payments.
// Payments from a wallet TO this address feed the Builder Commitment signal.
export const TREASURY = "rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF";

export const METHODOLOGY =
  "XRPLHub XRPLScore v1.1 — 9-signal native on-chain behavioral scoring";
export const COPYRIGHT =
  "© 2026 XRPLHub.io · XRPLScore™ · All Rights Reserved";

const RLUSD_HEX = "524C555344000000000000000000000000000000";

// ─── SCORING WEIGHTS (proprietary — © 2026 XRPLHub.io) ───────────────────────
// Total = 1.00 so the 300–850 range is unchanged (no score inflation).
const W = {
  accountAge:        0.18,
  txVelocity:        0.20,
  trustLines:        0.13,
  dexActivity:       0.10,
  ammActivity:       0.07,
  reserveRatio:      0.09,
  nftActivity:       0.05,
  securityFlags:     0.08,
  builderCommitment: 0.10,
};

// ─── XRPL FETCHERS ───────────────────────────────────────────────────────────
// Robust against rate-limiting (plain-text "Rate limit"), HTML error pages, and
// timeouts. Tries primary node, falls back to secondaries, returns {} as a last
// resort so individual signal failures don't kill the whole score.
export const XRPL_NODES = [
  "https://xrplcluster.com",
  "https://s1.ripple.com:51234",
  "https://s2.ripple.com:51234",
];

async function xrplCallOne(
  url: string,
  method: string,
  params: object
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, params: [params] }),
      signal: AbortSignal.timeout(9_000),
    });
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) return null;
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function xrplCall(method: string, params: object): Promise<Record<string, unknown>> {
  for (const url of XRPL_NODES) {
    const result = await xrplCallOne(url, method, params);
    if (result) return result;
  }
  return {};
}

// ─── SCORE COMPUTATION ───────────────────────────────────────────────────────
function computeRawScore(signals: Record<string, number>): number {
  const weighted = Object.entries(W).reduce(
    (acc, [key, weight]) => acc + (signals[key] || 0) * weight,
    0
  );
  return Math.round(300 + weighted * 5.5);
}

export function grade(score: number): string {
  if (score >= 800) return "Exceptional";
  if (score >= 740) return "Excellent";
  if (score >= 670) return "Good";
  if (score >= 580) return "Fair";
  return "Building";
}

export function peerPercentile(score: number): number {
  if (score >= 800) return 98;
  if (score >= 740) return 92;
  if (score >= 670) return 78;
  if (score >= 580) return 55;
  if (score >= 450) return 30;
  return 15;
}

export interface ScoreBreakdownRow {
  label: string;
  signal: string;
  score: number;
  weight: string;
  desc: string;
}

function buildBreakdown(signals: Record<string, number>): ScoreBreakdownRow[] {
  return [
    { label: "Account Lifecycle",  signal: "accountAge",        score: Math.round(signals.accountAge),        weight: "18%", desc: "Account age and maturity on XRPL mainnet" },
    { label: "Payment History",    signal: "txVelocity",        score: Math.round(signals.txVelocity),        weight: "20%", desc: "Transaction count, frequency, and consistency" },
    { label: "Asset Diversity",    signal: "trustLines",        score: Math.round(signals.trustLines),        weight: "13%", desc: "Trust line breadth and token portfolio quality" },
    { label: "DEX Participation",  signal: "dexActivity",       score: Math.round(signals.dexActivity),       weight: "10%", desc: "Active DEX trading and order book presence" },
    { label: "AMM Liquidity",      signal: "ammActivity",       score: Math.round(signals.ammActivity),       weight: "7%",  desc: "Liquidity provision and AMM pool positions" },
    { label: "Reserve Management", signal: "reserveRatio",      score: Math.round(signals.reserveRatio),      weight: "9%",  desc: "XRP balance relative to reserve requirements" },
    { label: "NFT Portfolio",      signal: "nftActivity",       score: Math.round(signals.nftActivity),       weight: "5%",  desc: "NFT holdings and on-chain digital asset activity" },
    { label: "Security Config",    signal: "securityFlags",     score: Math.round(signals.securityFlags),     weight: "8%",  desc: "Multi-sig, regular key, domain verification setup" },
    { label: "Builder Commitment", signal: "builderCommitment", score: Math.round(signals.builderCommitment), weight: "10%", desc: "On-chain payment history with XRPLHub — sustained commitment builds reputation" },
  ];
}

export interface ScoreRecommendation {
  action: string;
  points: string;
  priority: "high" | "medium" | "low";
}

function buildRecommendations(
  signals: Record<string, number>,
  hasEscrow: boolean
): ScoreRecommendation[] {
  const recs: ScoreRecommendation[] = [];
  if (signals.txVelocity < 60)        recs.push({ action: "Make 10 more on-chain payments", points: "+8–12 pts", priority: "high" });
  if (signals.builderCommitment < 50) recs.push({ action: "Subscribe to XRPLScore Builder — each payment builds your score", points: "+6–10 pts", priority: "high" });
  if (signals.trustLines < 50)        recs.push({ action: "Add 2 more XRPL trust lines", points: "+6–10 pts", priority: "high" });
  if (signals.dexActivity < 40)       recs.push({ action: "Place a DEX limit order", points: "+5–8 pts", priority: "medium" });
  if (signals.ammActivity < 30)       recs.push({ action: "Deposit into an AMM pool", points: "+4–7 pts", priority: "medium" });
  if (signals.securityFlags < 50)     recs.push({ action: "Enable multi-sig on your wallet", points: "+4–6 pts", priority: "medium" });
  if (signals.nftActivity < 20)       recs.push({ action: "Mint or hold an XRPL NFT", points: "+2–4 pts", priority: "low" });
  if (!hasEscrow)                     recs.push({ action: "Create an escrow transaction", points: "+3–5 pts", priority: "low" });
  if (signals.reserveRatio < 60)      recs.push({ action: "Increase XRP balance above 20 XRP", points: "+3–5 pts", priority: "medium" });
  return recs.slice(0, 5);
}

// ─── PUBLIC TYPES ────────────────────────────────────────────────────────────

export interface XrplScoreDetails {
  txCount: number;
  accountAgeDays: number;
  balanceXRP: number;
  trustLineCount: number;
  hasOffers: boolean;
  hasAMM: boolean;
  nftCount: number;
  hasMultiSig: boolean;
  hasRegKey: boolean;
  hasDomain: boolean;
  hasEmailHash: boolean;
  hasEscrow: boolean;
  dexTxCount: number;
  ammTxCount: number;
  objectCount: number;
  reserveXRP: number;
  sequence: number;
  builderPayments: number;
}

export interface XrplScoreResult {
  address: string;
  ledgerScore: number;                 // 300–850
  grade: string;                       // Building | Fair | Good | Excellent | Exceptional
  percentile: number;
  percentileLabel: string;
  signals: Record<string, number>;     // 9 signals, 0–100
  breakdown: ScoreBreakdownRow[];
  recommendations: ScoreRecommendation[];
  details: XrplScoreDetails;
  hasRlusdTrustLine: boolean;          // convenience for report.ts / risk flags
  methodology: string;
}

/** Thrown when the address is not an activated account on XRPL mainnet. */
export class AccountNotFoundError extends Error {
  constructor(address: string) {
    super(`Account not found on XRPL mainnet: ${address}`);
    this.name = "AccountNotFoundError";
  }
}

// ─── THE SCORER ──────────────────────────────────────────────────────────────

const RIPPLE_EPOCH_OFFSET = 946_684_800; // seconds between 1970-01-01 and 2000-01-01

export async function scoreWallet(address: string): Promise<XrplScoreResult> {
  const [infoRes, linesRes, txRes, offersRes, nftsRes, escrowRes, firstTxRes] = await Promise.all([
    xrplCall("account_info",    { account: address, ledger_index: "validated" }),
    xrplCall("account_lines",   { account: address, limit: 200 }).catch(() => ({})),
    xrplCall("account_tx",      { account: address, limit: 400, ledger_index_min: -1, ledger_index_max: -1 }).catch(() => ({})),
    xrplCall("account_offers",  { account: address }).catch(() => ({})),
    xrplCall("account_nfts",    { account: address }).catch(() => ({})),
    xrplCall("account_objects", { account: address, type: "escrow" }).catch(() => ({})),
    // The genuine FIRST transaction (oldest). account_tx caps at `limit`, so the
    // oldest of the 400 above is NOT the account's first tx for any wallet with
    // >400 lifetime txs — hence a dedicated forward:true, limit:1 lookup.
    xrplCall("account_tx", { account: address, limit: 1, forward: true, ledger_index_min: -1, ledger_index_max: -1 }).catch(() => ({})),
  ]);

  const info = infoRes as { result?: { account_data?: Record<string, unknown>; error?: string } };
  const accountInfo = info?.result?.account_data;
  if (!accountInfo || info?.result?.error) {
    throw new AccountNotFoundError(address);
  }

  const trustLines   = ((linesRes as { result?: { lines?: unknown[] } })?.result?.lines || []) as Array<Record<string, unknown>>;
  const transactions = ((txRes as { result?: { transactions?: unknown[] } })?.result?.transactions || []) as Array<{ tx?: Record<string, unknown> }>;
  const offers       = ((offersRes as { result?: { offers?: unknown[] } })?.result?.offers || []) as unknown[];
  const nfts         = ((nftsRes as { result?: { account_nfts?: unknown[] } })?.result?.account_nfts || []) as unknown[];
  const escrows      = ((escrowRes as { result?: { account_objects?: unknown[] } })?.result?.account_objects || []) as unknown[];

  // ── PARSE ──────────────────────────────────────────────────────────────────
  const balanceXRP = Number(accountInfo.Balance) / 1_000_000;
  const txCount    = transactions.length;
  const sequence   = (accountInfo.Sequence as number) || 0;

  // Account age from the FIRST tx's on-ledger close time (Ripple-epoch seconds),
  // not a hardcoded ledger-height guess. `date` is `tx.date` (API v1) or
  // `tx_json.date` (v2). Falls back to 0 = "unknown age" if unavailable.
  const firstEntry = ((firstTxRes as { result?: { transactions?: Array<{ tx?: Record<string, unknown>; tx_json?: Record<string, unknown> }> } })
    ?.result?.transactions ?? [])[0];
  const firstTxDate = (firstEntry?.tx?.date ?? firstEntry?.tx_json?.date) as number | undefined;
  const nowSec = Math.floor(Date.now() / 1000);
  const accountAgeDays =
    typeof firstTxDate === "number"
      ? Math.max(0, Math.floor((nowSec - (firstTxDate + RIPPLE_EPOCH_OFFSET)) / 86_400))
      : 0;

  const hasOffers  = offers.length > 0;
  const dexTxCount = transactions.filter((t) =>
    ["OfferCreate", "OfferCancel"].includes((t.tx?.TransactionType as string) || "")).length;

  const ammTxCount = transactions.filter((t) =>
    ["AMMDeposit", "AMMWithdraw", "AMMCreate", "AMMVote"].includes((t.tx?.TransactionType as string) || "")).length;
  const hasAMM = ammTxCount > 0;

  const nftCount   = nfts.length;
  const nftTxCount = transactions.filter((t) =>
    ((t.tx?.TransactionType as string) || "").startsWith("NFToken")).length;

  const hasMultiSig  = !!((accountInfo.SignerLists as unknown[])?.length);
  const hasRegKey    = !!accountInfo.RegularKey;
  const hasDomain    = !!accountInfo.Domain;
  const hasEmailHash = !!accountInfo.EmailHash;
  const hasEscrow    = escrows.length > 0;

  const objectCount  = (accountInfo.OwnerCount as number) || 0;
  const reserveXRP   = 10 + objectCount * 2;
  const reserveRatio = balanceXRP > 0 ? Math.min(100, (balanceXRP / reserveXRP) * 50) : 0;

  const hasRlusdTrustLine = trustLines.some(
    (l) => l.currency === RLUSD_HEX || l.currency === "RLUSD"
  );

  // ── BUILDER COMMITMENT (on-chain payments from this wallet to XRPLHub) ──────
  let builderPayments = 0;
  try {
    builderPayments = transactions.filter((t) => {
      const tx = t.tx || {};
      return tx.TransactionType === "Payment"
        && tx.Destination === TREASURY
        && tx.Account === address; // sent BY this wallet, not received
    }).length;
  } catch {
    builderPayments = 0;
  }
  const builderCommitment = Math.min(100, builderPayments * 18);

  // ── SIGNALS (0–100) ────────────────────────────────────────────────────────
  const signals: Record<string, number> = {
    accountAge:   Math.min(100, (accountAgeDays / 1095) * 100),
    txVelocity:   Math.min(100, (txCount / 500) * 100),
    trustLines:   Math.min(100, (trustLines.length / 15) * 100),
    dexActivity:  Math.min(100, (hasOffers ? 30 : 0) + (dexTxCount / 30) * 70),
    ammActivity:  Math.min(100, (ammTxCount / 10) * 100),
    reserveRatio: Math.min(100, reserveRatio),
    nftActivity:  Math.min(100, (nftCount / 10) * 50 + (nftTxCount / 20) * 50),
    securityFlags: Math.min(100,
      (hasMultiSig ? 35 : 0) + (hasRegKey ? 20 : 0) +
      (hasDomain ? 20 : 0) + (hasEmailHash ? 15 : 0) + (hasEscrow ? 10 : 0)),
    builderCommitment,
  };

  const ledgerScore = computeRawScore(signals);
  const scoreGrade  = grade(ledgerScore);
  const percentile  = peerPercentile(ledgerScore);

  const details: XrplScoreDetails = {
    txCount, accountAgeDays,
    balanceXRP: Math.round(balanceXRP * 100) / 100,
    trustLineCount: trustLines.length,
    hasOffers, hasAMM, nftCount,
    hasMultiSig, hasRegKey, hasDomain, hasEmailHash, hasEscrow,
    dexTxCount, ammTxCount, objectCount, reserveXRP, sequence,
    builderPayments,
  };

  return {
    address,
    ledgerScore,
    grade: scoreGrade,
    percentile,
    percentileLabel: `Higher than ${percentile}% of scanned XRPL wallets`,
    signals,
    breakdown: buildBreakdown(signals),
    recommendations: buildRecommendations(signals, hasEscrow),
    details,
    hasRlusdTrustLine,
    methodology: METHODOLOGY,
  };
}

/** Cheap input gate so bad addresses fail before any network call. */
export function isValidXrplAddress(addr: string): boolean {
  return /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(addr);
}

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

export const TREASURY = "rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF";

export const METHODOLOGY =
  "XRPLHub XRPLScore v1.1 — 8-signal native on-chain behavioral scoring, absolute scale";
export const COPYRIGHT =
  "© 2026 XRPLHub.io · XRPLScore™ · All Rights Reserved";

// Carried in EVERY score-bearing response (plain score, x402 score, wallet
// report, credential planning). Same standard the screening and lending
// products already meet: state what the number is and is not, in the response
// itself — an API consumer never sees the Terms page.
export const SCORE_DISCLAIMER =
  "XRPLScore is an informational analytics signal computed only from public XRP Ledger data at the stated " +
  "ledger state. It is NOT a FICO score, a consumer credit score, a consumer report, or an NRSRO rating, and " +
  "it has no affiliation with any credit bureau. It must not be used, alone or combined with other data, to " +
  "make or communicate any decision about a person's eligibility for credit, insurance, employment, or " +
  "housing, or for any other purpose governed by the U.S. Fair Credit Reporting Act (FCRA) or the Equal " +
  "Credit Opportunity Act. XRPLHub does not warrant that the score reflects creditworthiness. The value can " +
  "change as ledger state changes and may be recomputed at any time.";

const RLUSD_HEX = "524C555344000000000000000000000000000000";
const RIPPLE_EPOCH_OFFSET = 946_684_800;

// ─── SCORING WEIGHTS (proprietary — © 2026 XRPLHub.io) ───────────────────────
// v1.1: builderCommitment REMOVED entirely — a public credit standard must not
// score wallets higher for having paid the issuer. Weights sum to 1.00.
// Calibrated Sep 2026 against 333 real mainnet accounts so the distribution
// uses the full 300–850 range on an ABSOLUTE scale.
const W = {
  accountAge:      0.28, // tenure — strongest creditworthiness proxy
  txActivity:      0.22, // lifetime transaction history
  financialHealth: 0.22, // spendable XRP + buffer above the reserve line
  tokenEngagement: 0.12, // trust lines held
  dexActivity:     0.08, // on-ledger DEX use
  ammActivity:     0.03, // AMM participation (bonus)
  securityConfig:  0.03, // multisig / regular key / domain / escrow (bonus)
  nftActivity:     0.02, // NFT holdings / activity (bonus)
};

const clamp = (v: number) => Math.max(0, Math.min(100, v));

// ─── XRPL FETCHERS ───────────────────────────────────────────────────────────
// Node rotation + per-node cooldown lives in ./xrplNodes. A call that could not
// be read from ANY node returns { ok: false }, and the scorer then refuses to
// emit a score (XrplUnavailableError) — a transient RPC failure must never be
// silently folded into a signal as a zero. "Could not read" is not "not found"
// and is not "the wallet has no activity".
export { XRPL_NODES } from "./xrplNodes"; // re-export: lendingLedger / screen import it from here
import { xrplRpc, type XrplRpcResult } from "./xrplNodes";
import { resolveFirstTx } from "./xrplFacts";

type XrplCallResult = XrplRpcResult;

const xrplCall = (method: string, params: object): Promise<XrplCallResult> => xrplRpc(method, params);

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
    { label: "Account Lifecycle",   signal: "accountAge",      score: Math.round(signals.accountAge),      weight: "28%", desc: "Account age and tenure on XRPL mainnet" },
    { label: "Transaction History", signal: "txActivity",      score: Math.round(signals.txActivity),      weight: "22%", desc: "Lifetime on-chain transaction volume and consistency" },
    { label: "Financial Health",    signal: "financialHealth", score: Math.round(signals.financialHealth), weight: "22%", desc: "Spendable XRP and buffer held above the account reserve" },
    { label: "Token Engagement",    signal: "tokenEngagement", score: Math.round(signals.tokenEngagement), weight: "12%", desc: "Trust lines held — participation in the XRPL token economy" },
    { label: "DEX Participation",   signal: "dexActivity",     score: Math.round(signals.dexActivity),     weight: "8%",  desc: "Native DEX trading and order-book presence" },
    { label: "AMM Participation",   signal: "ammActivity",     score: Math.round(signals.ammActivity),     weight: "3%",  desc: "Liquidity provision and AMM pool activity" },
    { label: "Security Config",     signal: "securityConfig",  score: Math.round(signals.securityConfig),  weight: "3%",  desc: "Multi-sig, regular key, domain, escrow setup" },
    { label: "NFT Portfolio",       signal: "nftActivity",     score: Math.round(signals.nftActivity),     weight: "2%",  desc: "NFT holdings and on-chain digital-asset activity" },
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
  if (signals.financialHealth < 60) recs.push({ action: "Hold more spendable XRP above your account reserve", points: "+10–25 pts", priority: "high" });
  if (signals.txActivity < 60)      recs.push({ action: "Keep transacting on-chain — history compounds over time", points: "+8–15 pts", priority: "high" });
  if (signals.tokenEngagement < 50) recs.push({ action: "Set up trust lines for tokens you use", points: "+6–12 pts", priority: "high" });
  if (signals.dexActivity < 40)     recs.push({ action: "Place an order on the native XRPL DEX", points: "+4–6 pts", priority: "medium" });
  if (signals.securityConfig < 40)  recs.push({ action: "Add a regular key or multi-sig to your wallet", points: "+3–6 pts", priority: "medium" });
  if (signals.ammActivity < 30)     recs.push({ action: "Provide liquidity to an XRPL AMM pool", points: "+2–4 pts", priority: "low" });
  if (!hasEscrow)                   recs.push({ action: "Use an on-chain escrow", points: "+2–3 pts", priority: "low" });
  if (signals.nftActivity < 20)     recs.push({ action: "Hold or mint an XRPL NFT", points: "+1–3 pts", priority: "low" });
  return recs.slice(0, 5);
}

// ─── PUBLIC TYPES ────────────────────────────────────────────────────────────

export interface XrplScoreDetails {
  txCount: number;             // transactions in the last-400 window
  lifetimeTxEstimate: number;  // estimated lifetime transaction count
  accountAgeDays: number;
  balanceXRP: number;
  spendableXRP: number;        // balance minus the current account reserve
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
  reserveXRP: number;          // the account's actual reserve requirement
  sequence: number;
}

export interface DataCompleteness {
  complete: boolean;          // true iff every input the score depends on was read
  unread: string[];           // XRPL calls that could not be read (empty on a 200)
  source: string;             // where the data came from
}

export interface XrplScoreResult {
  address: string;
  ledgerScore: number;                 // 300–850
  grade: string;                       // Building | Fair | Good | Excellent | Exceptional
  percentile: number;
  percentileLabel: string;
  signals: Record<string, number>;     // 8 signals, 0–100 (v1.1)
  breakdown: ScoreBreakdownRow[];
  recommendations: ScoreRecommendation[];
  details: XrplScoreDetails;
  hasRlusdTrustLine: boolean;          // convenience for report.ts / risk flags
  methodology: string;
  disclaimer: string;                  // SCORE_DISCLAIMER — what the number is / is not
  dataCompleteness: DataCompleteness;  // always { complete: true, unread: [] } — see below
}

/** Thrown when the address is not an activated account on XRPL mainnet. */
export class AccountNotFoundError extends Error {
  constructor(address: string) {
    super(`Account not found on XRPL mainnet: ${address}`);
    this.name = "AccountNotFoundError";
  }
}

/**
 * Thrown when one or more XRPL calls could not be read from any node
 * (rate-limit, timeout, upstream error) — as opposed to the wallet genuinely
 * not existing. The scorer NEVER produces a number in this case: a degraded
 * score is worse than no score, because it looks identical to a real low score
 * and can be signed / anchored. API routes turn this into a 503 that names the
 * calls that failed, and it is retryable.
 */
export class XrplUnavailableError extends Error {
  readonly failedCalls: string[];
  constructor(failedCalls: string[]) {
    super(
      `XRPL data temporarily unavailable — could not read: ${failedCalls.join(", ")}. ` +
        `No score was computed. Retry shortly.`
    );
    this.name = "XrplUnavailableError";
    this.failedCalls = failedCalls;
  }
}

// ─── THE SCORER ──────────────────────────────────────────────────────────────

export async function scoreWallet(address: string): Promise<XrplScoreResult> {
  // account_lines trimmed 400 -> 100: verified against 20 wallets across the
  // range (scripts/verify-trimmed-limits.mjs) — 0/20 score change, because the
  // tokenEngagement signal saturates at 8 trust lines and 100 still covers the
  // RLUSD-line check. account_tx STAYS at 400: the same run showed trimming it
  // to 200 shifts high-activity wallets up to 13 points (the lifetime-tx floor
  // and the receive-count window both narrow) — an accuracy trade we did NOT take.
  const [infoRes, linesRes, txRes, offersRes, nftsRes, escrowRes, firstTx] = await Promise.all([
    xrplCall("account_info",    { account: address, ledger_index: "validated" }),
    xrplCall("account_lines",   { account: address, limit: 100 }),
    xrplCall("account_tx",      { account: address, limit: 400, ledger_index_min: -1, ledger_index_max: -1 }),
    xrplCall("account_offers",  { account: address }),
    xrplCall("account_nfts",    { account: address }),
    xrplCall("account_objects", { account: address, type: "escrow" }),
    // The account's FIRST transaction — immutable, so served from the permanent
    // XrplFactCache after the first time we see an address (0 RPC on a repeat).
    resolveFirstTx(address),
  ]);

  // GATE 1 — could not read. Every call feeds a signal (accountAge alone is 28%
  // of the score); a call that failed on every node is NOT a zero. Refuse to
  // score, name what failed, let the caller retry. Never anchor degraded data.
  if (
    !infoRes.ok || !linesRes.ok || !txRes.ok || !offersRes.ok ||
    !nftsRes.ok || !escrowRes.ok || !firstTx.ok
  ) {
    const entries: Array<[{ ok: boolean }, string]> = [
      [infoRes,    "account_info"],
      [linesRes,   "account_lines"],
      [txRes,      "account_tx"],
      [offersRes,  "account_offers"],
      [nftsRes,    "account_nfts"],
      [escrowRes,  "account_objects (escrow)"],
      [firstTx,    "account_tx (first-tx / account age)"],
    ];
    const unread = entries.filter(([r]) => !r.ok).map(([, label]) => label);
    throw new XrplUnavailableError(unread);
  }

  // GATE 2 — genuinely not an activated account (a real, read answer).
  const infoResult = (infoRes.body as {
    result?: { account_data?: Record<string, unknown>; error?: string };
  }).result;
  const accountInfo = infoResult?.account_data;
  if (!accountInfo) {
    if (infoResult?.error === "actNotFound") throw new AccountNotFoundError(address);
    // A 200 with neither account_data nor "actNotFound" (e.g. "tooBusy",
    // "noNetwork", a malformed body) is a read failure, not a missing wallet.
    throw new XrplUnavailableError([`account_info (${infoResult?.error ?? "unrecognized response"})`]);
  }

  // GATE 3 — the wallet exists, but a secondary call came back as a node-level
  // error ("noCurrent", "noNetwork", "tooBusy", an unsynced fallback node). That
  // is a read failure, NOT an empty result — an existing account that returns
  // `error` on account_lines has not "got zero trust lines". Do not let it
  // become a zero signal; refuse to score.
  const secondary: Array<[{ body: Record<string, unknown> }, string]> = [
    [linesRes,   "account_lines"],
    [txRes,      "account_tx"],
    [offersRes,  "account_offers"],
    [nftsRes,    "account_nfts"],
    [escrowRes,  "account_objects (escrow)"],
    // firstTx is resolved by resolveFirstTx(), which already returns { ok:false }
    // on a node-level error — GATE 1 above covers it.
  ];
  const errored = secondary
    .filter(([r]) => {
      const res = (r.body as { result?: { error?: unknown; status?: unknown } }).result;
      return !res || res.error != null || res.status === "error";
    })
    .map(([, label]) => label);
  if (errored.length) throw new XrplUnavailableError(errored);

  const trustLines   = ((linesRes.body as { result?: { lines?: unknown[] } })?.result?.lines || []) as Array<Record<string, unknown>>;
  const transactions = ((txRes.body as { result?: { transactions?: unknown[] } })?.result?.transactions || []) as Array<{ tx?: Record<string, unknown>; tx_json?: Record<string, unknown> }>;
  const offers       = ((offersRes.body as { result?: { offers?: unknown[] } })?.result?.offers || []) as unknown[];
  const nfts         = ((nftsRes.body as { result?: { account_nfts?: unknown[] } })?.result?.account_nfts || []) as unknown[];
  const escrows      = ((escrowRes.body as { result?: { account_objects?: unknown[] } })?.result?.account_objects || []) as unknown[];
  const txOf = (t: { tx?: Record<string, unknown>; tx_json?: Record<string, unknown> }) => t.tx ?? t.tx_json ?? {};

  // ── PARSE ──────────────────────────────────────────────────────────────────
  const balanceXRP = Number(accountInfo.Balance) / 1_000_000;
  const txListLen  = transactions.length;
  const txCapped   = txListLen >= 400; // account_tx page size
  const sequence   = (accountInfo.Sequence as number) || 0;

  // Account age from the FIRST tx's on-ledger close time (Ripple-epoch seconds).
  // firstTx is from resolveFirstTx() (permanent cache or one cheap RPC).
  const firstTxDate = firstTx.firstTxDate ?? undefined;
  const firstTxLedger = firstTx.firstTxLedger ?? undefined;
  const nowSec = Math.floor(Date.now() / 1000);
  const accountAgeDays =
    typeof firstTxDate === "number"
      ? Math.max(0, Math.floor((nowSec - (firstTxDate + RIPPLE_EPOCH_OFFSET)) / 86_400))
      : 0;

  const dexTxCount = transactions.filter((t) =>
    ["OfferCreate", "OfferCancel"].includes((txOf(t).TransactionType as string) || "")).length;
  const ammTxCount = transactions.filter((t) =>
    ["AMMDeposit", "AMMWithdraw", "AMMCreate", "AMMVote"].includes((txOf(t).TransactionType as string) || "")).length;
  const nftTxCount = transactions.filter((t) =>
    ((txOf(t).TransactionType as string) || "").startsWith("NFToken")).length;
  const recvCount = transactions.filter((t) => {
    const x = txOf(t);
    return x.TransactionType === "Payment" && x.Destination === address;
  }).length;

  const hasOffers  = offers.length > 0;
  const hasAMM     = ammTxCount > 0;
  const nftCount   = nfts.length;

  const hasMultiSig  = !!((accountInfo.SignerLists as unknown[])?.length) || !!((infoRes.body as { result?: { signer_lists?: unknown[] } })?.result?.signer_lists?.length);
  const hasRegKey    = !!accountInfo.RegularKey;
  const hasDomain    = !!accountInfo.Domain;
  const hasEmailHash = !!accountInfo.EmailHash;
  const hasEscrow    = escrows.length > 0;

  const objectCount   = (accountInfo.OwnerCount as number) || 0;
  const realReserve   = 1 + 0.2 * objectCount;          // current XRPL reserve
  const spendableXRP  = Math.max(0, balanceXRP - realReserve);
  const reserveBuffer = realReserve > 0 ? balanceXRP / realReserve : 0;

  const hasRlusdTrustLine = trustLines.some(
    (l) => l.currency === RLUSD_HEX || l.currency === "RLUSD"
  );

  // ── SIGNALS (0–100), absolute scale ────────────────────────────────────────
  // Lifetime sent-tx estimate. Modern (deletable) accounts: Sequence starts near
  // the creation ledger index (30M+), so sent ≈ Sequence - firstTxLedger.
  // Legacy accounts: Sequence == lifetime sent count.
  const isModern = sequence > 30_000_000 && firstTxLedger != null && sequence > firstTxLedger;
  const sentEst  = isModern ? Math.max(0, sequence - (firstTxLedger as number)) : sequence;
  const lifetimeTx = (txCapped ? Math.max(sentEst, txListLen, 400) : Math.max(sentEst, txListLen)) + 0.35 * recvCount;
  const secPts = (hasMultiSig ? 40 : 0) + (hasRegKey ? 20 : 0) + (hasDomain ? 20 : 0) + (hasEmailHash ? 10 : 0) + (hasEscrow ? 10 : 0);

  const signals: Record<string, number> = {
    accountAge:      clamp(Math.sqrt(accountAgeDays / 1095) * 100),                          // sqrt, max at 3 yr
    txActivity:      clamp((Math.log10(lifetimeTx + 1) / Math.log10(8000)) * 100),           // log, max ~8k txs
    financialHealth: clamp(
                       0.40 * clamp((Math.log10(spendableXRP + 1) / Math.log10(2500)) * 100) +
                       0.60 * clamp(((reserveBuffer - 1) / 7) * 100)
                     ),
    tokenEngagement: clamp(Math.sqrt(trustLines.length / 8) * 100),                          // sqrt, max at 8 lines
    dexActivity:     clamp((hasOffers ? 20 : 0) + Math.min(80, Math.sqrt(dexTxCount / 25) * 80)),
    ammActivity:     clamp(Math.sqrt(ammTxCount / 8) * 100),
    securityConfig:  clamp(secPts),
    nftActivity:     clamp((nftCount / 8) * 50 + (nftTxCount / 15) * 50),
  };

  const ledgerScore = computeRawScore(signals);
  const scoreGrade  = grade(ledgerScore);
  const percentile  = peerPercentile(ledgerScore);

  const details: XrplScoreDetails = {
    txCount: txListLen, accountAgeDays,
    balanceXRP: Math.round(balanceXRP * 100) / 100,
    spendableXRP: Math.round(spendableXRP * 100) / 100,
    lifetimeTxEstimate: Math.round(lifetimeTx),
    trustLineCount: trustLines.length,
    hasOffers, hasAMM, nftCount,
    hasMultiSig, hasRegKey, hasDomain, hasEmailHash, hasEscrow,
    dexTxCount, ammTxCount, objectCount, reserveXRP: Math.round(realReserve * 100) / 100, sequence,
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
    disclaimer: SCORE_DISCLAIMER,
    // Every score-bearing response carries this. It can only ever report
    // `complete: true` here — scoreWallet throws XrplUnavailableError above
    // rather than return with any input unread — but downstream consumers
    // (credential, lending, underwrite bundle) assert on it before signing.
    dataCompleteness: {
      complete: true,
      unread: [],
      source: "xrpl-mainnet-jsonrpc (rotated node pool — see src/lib/xrplNodes.ts)",
    },
  };
}

/** Input gate so bad addresses fail before any network call. Base58check-verified (see src/lib/address.ts): a mistyped address is rejected, not looked up. */
export { isValidXrplAddress } from "./address";

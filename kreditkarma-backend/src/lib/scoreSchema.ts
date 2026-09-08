// src/lib/scoreSchema.ts
// The XRPLScore output shape, in one place, so every surface that advertises
// it — the RLUSD/XRPL x402 discovery entry AND the USDC/Base per-call route —
// describes literally the same object computeScore() returns and can't drift.

export const walletProp = {
  type: "string",
  pattern: "^r[1-9A-HJ-NP-Za-km-z]{24,34}$",
  description: "XRPL classic address (r...) to score.",
  example: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
};

export const SCORE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    wallet: { type: "string", description: "The address that was scored." },
    score: { type: "integer", minimum: 300, maximum: 850, description: "XRPLScore, 300–850 (absolute scale)." },
    grade: { type: "string", enum: ["Building", "Fair", "Good", "Excellent", "Exceptional"] },
    percentile: { type: "number", description: "Peer percentile band, 0–100." },
    signals: {
      type: "object",
      description: "The 8 component scores, 0–100 each.",
      properties: {
        accountAge: { type: "number" }, txActivity: { type: "number" },
        financialHealth: { type: "number" }, tokenEngagement: { type: "number" },
        dexActivity: { type: "number" }, ammActivity: { type: "number" },
        securityConfig: { type: "number" }, nftActivity: { type: "number" },
      },
    },
    methodology: { type: "string" },
    disclaimer: {
      type: "string",
      description:
        "What the number is and is not: informational only, NOT a FICO score / consumer report / NRSRO " +
        "rating, and not permissible for FCRA- or ECOA-governed decisions. Always present.",
    },
    dataCompleteness: {
      type: "object",
      description:
        "Whether every XRPL input the score depends on was read. `complete` is always true on a 200 — the " +
        "engine returns 503 (not a score) if any call could not be read, rather than folding a failure into a signal.",
      properties: {
        complete: { type: "boolean" },
        unread: { type: "array", items: { type: "string" } },
        source: { type: "string" },
      },
    },
    computedAt: { type: "string", format: "date-time" },
  },
  required: ["wallet", "score", "grade", "signals", "disclaimer", "dataCompleteness"],
} as const;

export const SCORE_OUTPUT_EXAMPLE = {
  wallet: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
  score: 721,
  grade: "Good",
  percentile: 74,
  signals: {
    accountAge: 88, txActivity: 71, financialHealth: 64, tokenEngagement: 61,
    dexActivity: 40, ammActivity: 12, securityConfig: 30, nftActivity: 0,
  },
  methodology: "XRPLHub XRPLScore v1.1 — 8-signal native on-chain behavioral scoring, absolute scale",
  disclaimer:
    "XRPLScore is an informational analytics signal computed only from public XRP Ledger data. It is NOT a " +
    "FICO score, a consumer credit score, a consumer report, or an NRSRO rating, and must not be used for any " +
    "purpose governed by the U.S. Fair Credit Reporting Act or the Equal Credit Opportunity Act.",
  dataCompleteness: { complete: true, unread: [], source: "xrpl-mainnet-jsonrpc (xrplcluster → s1 → s2)" },
  computedAt: "2026-09-04T00:00:00.000Z",
};

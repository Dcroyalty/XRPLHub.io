// src/lib/paycall.ts
// Pay-per-call (x402-style) pricing + helpers for autonomous bot purchases.
// Prices are set UNDER the ~$0.50 autonomous-spend threshold so AI agents
// pay without human approval. One source of truth — change here, everywhere
// moves.

// Per-call price for a single wallet score (bot pays, gets one score).
export const PRICE_PER_SCORE_RLUSD = 0.05;

// Price for a prebuilt product (report/credential/etc). Used later.
export const PRICE_PER_PRODUCT_RLUSD = 0.25;

// How long an unpaid quote stays valid before it expires.
export const QUOTE_TTL_MINUTES = 15;

// Reuse the proven treasury + RLUSD constants from the checkout code.
export {
  TREASURY_ADDRESS,
  RLUSD_ISSUER,
  RLUSD_CURRENCY_HEX,
} from "@/lib/rlusd";

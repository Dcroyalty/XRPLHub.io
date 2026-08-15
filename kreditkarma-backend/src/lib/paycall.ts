// src/lib/paycall.ts
// Pay-per-call (x402-style) pricing + helpers for autonomous bot purchases.
// Priced to undercut the wallet-risk category on the xrpl-ai.org Index
// (comparable wallet scans ~0.0877 XRP, portfolio scans ~0.012 XRP) while
// staying above "toy tool" pricing. All under the ~$0.50 autonomous line.
// One source of truth — change here, everywhere moves.

// Per-call price for a single wallet score.
export const PRICE_PER_SCORE_RLUSD = 0.02;

// Full wallet risk report (score + flags + signals + on-chain snapshot).
export const PRICE_PER_PRODUCT_RLUSD = 0.08;

// Prebuilt ready-to-sign XRPL transaction (27-service engine).
export const PRICE_PER_TX_PRODUCT_RLUSD = 0.15;

// How long an unpaid quote stays valid before it expires.
export const QUOTE_TTL_MINUTES = 15;

// Reuse the proven treasury + RLUSD constants from the checkout code.
export {
  TREASURY_ADDRESS,
  RLUSD_ISSUER,
  RLUSD_CURRENCY_HEX,
} from "@/lib/rlusd";

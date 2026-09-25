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


// The four resources that are payable on BOTH rails (USDC on Base via CDP, RLUSD on XRPL via t54) at the same face value
// as their Base price in src/lib/x402Base.ts. Kept as literals here (not imported) so this file stays free of the CDP/viem
// import chain; src/lib/x402Dual.ts checks on every request that the two rails quote the same price and fails closed if not.
// (/api/x402/tx is NOT priced here: it charges the storefront price of the requested service, src/lib/servicePrices.ts.)
export const PRICE_PER_SCREEN_RLUSD = 0.01; // OFAC SDN screening attestation
export const PRICE_PER_MPT_RLUSD = 0.01; // full MPT issuer risk view
export const PRICE_PER_EXPOSURE_RLUSD = 0.01; // XLS-66 cross-broker lending exposure
export const PRICE_PER_UNDERWRITE_RLUSD = 0.05; // underwriting-inputs bundle

// How long an unpaid quote stays valid before it expires.
export const QUOTE_TTL_MINUTES = 15;

// Reuse the proven treasury + RLUSD constants from the checkout code.
export {
  TREASURY_ADDRESS,
  RLUSD_ISSUER,
  RLUSD_CURRENCY_HEX,
} from "@/lib/rlusd";

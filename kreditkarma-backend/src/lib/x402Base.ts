// src/lib/x402Base.ts
// USDC-on-Base payment rail config. Additive alongside the existing RLUSD
// (src/lib/x402.ts, XRPL t54 facilitator) and XRP/RLUSD checkout (src/lib/rlusd.ts) —
// none of that is touched here.
//
// WHY x402-next v1 (not v2): the newer @x402/* v2 package family (and
// @coinbase/x402@2.x, which depends on @x402/core) sends payloads the live
// CDP REST facilitator rejects. x402-next + @coinbase/x402 stayed pinned to
// the v1 protocol line (both depend on the unscoped `x402` package, ^1.x) and
// that is what actually round-trips against api.cdp.coinbase.com. Verified
// end-to-end against this deployment's real CDP_API_KEY_ID/SECRET before this
// file was written (see the admin/cdp-diag diagnostic, since deleted).
//
// WHY no destination-tag / unique-amount matching: x402's "exact" scheme binds
// the invoice into the buyer's signed EIP-3009 authorization itself (payTo,
// asset, amount, resource, nonce, validity window) and the facilitator settles
// it inside the same request/response cycle. There is nothing to reconcile
// after the fact the way an XRPL destination tag reconciles an async ledger
// scan — so no unique pricing tricks, no polling.

import { getAddress, type Address } from "viem";
import { facilitator } from "@coinbase/x402";

// The wallet that receives USDC. Confirmed with the user directly — this
// project has no other Base/EVM address anywhere. getAddress() both validates
// the checksum and normalizes casing; a malformed address throws at import
// time (fail loud, not into a bad on-chain destination).
export const BASE_PAY_TO: Address = getAddress(
  process.env.BASE_PAY_TO_ADDRESS ?? "0xe0ed7a30589fec49e98f2085c7162b90fdbb83de"
);

// Mainnet only. "base" resolves to native USDC by default in x402@1.x
// (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 — confirmed against the actual
// x402 package source, matches the contract the user gave).
export const BASE_NETWORK = "base" as const;
export const USDC_BASE_ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

// Per-call agent pricing (distinct from the $29/$149/$499 human subscription
// plans in src/lib/plans.ts) — market rate for agent-purchased API calls is
// $0.002-$0.025; nothing at subscription pricing sells to an agent.
export const PRICE_PER_SCORE_USDC = 0.01;
export const PRICE_PER_MPT_USDC = 0.01; // full MPT issuer risk view

// Display-only mirror of what @coinbase/x402's `facilitator` actually calls —
// for the .well-known/x402 discovery document, which needs a URL string, not
// the {url, createAuthHeaders} config object itself.
export const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402" as const;

// Re-exported so route files have one import source for this rail.
export { facilitator as cdpFacilitator };

// src/app/api/x402/score/route.ts
// XRPLScore, paid per call over x402 on EITHER rail at one price ($0.02): RLUSD on the XRP Ledger (x402 v2, t54) or
// USDC on Base (x402 v1, CDP). XRPL-only until 2026-10-05 — an existing XRPL client sees no change. The same product
// (POST body instead of GET query) is POST /api/x402/usdc/score.
//
// AGENT-SAFE: schema in the challenge; settle only after computeScore() succeeds; a retried request (Idempotency-Key
// or the invoiceId) replays the stored response instead of paying again. Wiring: src/lib/x402WalletGet.ts.
import { computeScore } from "@/lib/engine";
import { PRICE_PER_SCORE_RLUSD } from "@/lib/paycall";
import { PRICE_PER_SCORE_USDC } from "@/lib/x402Base";
import { SCORE_SCHEMA } from "@/lib/x402Schemas";
import { walletGetDual } from "@/lib/x402WalletGet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = walletGetDual({
  resource: "/api/x402/score",
  plan: "x402:score",
  amountRlusd: PRICE_PER_SCORE_RLUSD,
  amountUsdc: PRICE_PER_SCORE_USDC,
  name: "XRPLScore — Wallet Risk Score",
  schema: SCORE_SCHEMA,
  compute: computeScore,
});

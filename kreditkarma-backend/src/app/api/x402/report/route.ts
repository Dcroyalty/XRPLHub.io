// src/app/api/x402/report/route.ts
// Full Wallet Risk Report, paid per call over x402 on EITHER rail at one price ($0.08): RLUSD on the XRP Ledger
// (x402 v2, t54) or USDC on Base (x402 v1, CDP). XRPL-only until 2026-10-05 — an existing XRPL client sees no change.
//
// AGENT-SAFE: schema in the challenge; settle only after buildWalletReport() succeeds; idempotent replay on retry.
// Wiring: src/lib/x402WalletGet.ts -> src/lib/x402Dual.ts.
import { buildWalletReport } from "@/lib/report";
import { PRICE_PER_PRODUCT_RLUSD } from "@/lib/paycall";
import { PRICE_PER_REPORT_USDC } from "@/lib/x402Base";
import { REPORT_SCHEMA } from "@/lib/x402Schemas";
import { walletGetDual } from "@/lib/x402WalletGet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = walletGetDual({
  resource: "/api/x402/report",
  plan: "x402:report",
  amountRlusd: PRICE_PER_PRODUCT_RLUSD,
  amountUsdc: PRICE_PER_REPORT_USDC,
  name: "XRPLHub — Full Wallet Risk Report",
  schema: REPORT_SCHEMA,
  compute: buildWalletReport,
});

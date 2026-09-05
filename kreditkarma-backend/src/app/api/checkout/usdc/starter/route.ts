// src/app/api/checkout/usdc/starter/route.ts
// Buy the Starter plan with USDC on Base, via x402 (agents and browser
// wallets both use this same 402-challenge + signed-authorization flow — see
// src/lib/x402Base.ts for why). Additive: does not touch /api/checkout
// (XRP/RLUSD) or /api/checkout/status.
import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "x402-next";
import { BASE_PAY_TO, BASE_NETWORK, cdpFacilitator } from "@/lib/x402Base";
import { PLANS } from "@/lib/plans";
import { mintPlanKey, USDC_PLAN_OUTPUT_SCHEMA } from "@/lib/checkoutUsdc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const plan = PLANS.starter;

const handler = async (_req: NextRequest): Promise<NextResponse<unknown>> => mintPlanKey("starter");

export const GET = withX402(
  handler,
  BASE_PAY_TO,
  {
    price: `$${plan.priceRlusd}`,
    network: BASE_NETWORK,
    config: {
      description:
        `Buy the ${plan.name} XRPLHub API plan (${plan.monthlyQuota.toLocaleString()} scored XRPL wallet-risk ` +
        `calls/month, ${plan.rateLimitPerMin} req/min) with USDC on Base. One signed EIP-3009 authorization ` +
        `— no gas, no separate on-chain tx from you — settles immediately and returns a live API key in the ` +
        `same response. No signup, no invoice, no polling.`,
      mimeType: "application/json",
      discoverable: true,
      outputSchema: USDC_PLAN_OUTPUT_SCHEMA,
    },
  },
  cdpFacilitator
);

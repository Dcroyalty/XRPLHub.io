// src/app/api/checkout/usdc/scale/route.ts
// Buy the Scale plan with USDC on Base. See src/app/api/checkout/usdc/starter/route.ts
// for the full explanation — identical shape, different plan.
import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "x402-next";
import { BASE_PAY_TO, BASE_NETWORK, cdpFacilitator } from "@/lib/x402Base";
import { PLANS } from "@/lib/plans";
import { mintPlanKey } from "@/lib/checkoutUsdc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const plan = PLANS.scale;

const handler = async (_req: NextRequest): Promise<NextResponse<unknown>> => mintPlanKey("scale");

export const GET = withX402(
  handler,
  BASE_PAY_TO,
  {
    price: `$${plan.priceRlusd}`,
    network: BASE_NETWORK,
    config: {
      description: `XRPLHub API — ${plan.name} plan (${plan.monthlyQuota.toLocaleString()} scored calls/mo), paid in USDC on Base`,
    },
  },
  cdpFacilitator
);

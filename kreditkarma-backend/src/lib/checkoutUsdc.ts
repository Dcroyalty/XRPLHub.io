// src/lib/checkoutUsdc.ts
// Shared handler for the 3 USDC-on-Base plan-purchase routes
// (src/app/api/checkout/usdc/{starter,growth,scale}/route.ts).
//
// By the time this runs, x402-next's withX402() has already verified the
// buyer's signed EIP-3009 authorization against the facilitator — settlement
// (the actual on-chain transfer) happens right after this returns, and ONLY
// if this returns a <400 response (withX402 skips settling on failure, same
// "never charge for a failure" guarantee the RLUSD path gets from settling
// before delivery). One asymmetry worth knowing: settlement happens AFTER
// this handler's side effects (the key is already minted+stored), so a rare
// post-verify settlement failure (facilitator relay hiccup, not a bad
// payment) could leave a key minted whose on-chain leg never completed. Same
// trade-off Coinbase's own docs make this the recommended pattern around;
// accepted here rather than re-deriving x402 from scratch.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { generateApiKey } from "@/lib/keys";
import { getPlan, type PlanId } from "@/lib/plans";

const MAX_TAG = 2_147_483_647; // Invoice.destinationTag is a unique 32-bit int

// Kept next to the handler it actually describes so it can't drift — reused
// by every checkout/usdc/*/route.ts (feeds the CDP Bazaar's discovery
// listing) and by the .well-known/x402 document (feeds xrpl-ai.org/x402scan).
export const USDC_PLAN_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["paid"], description: "Always 'paid' — this response is only returned after the CDP facilitator settles the payment." },
    plan: { type: "string", enum: ["starter", "growth", "scale"], description: "The plan that was purchased." },
    currency: { type: "string", enum: ["USDC"] },
    network: { type: "string", enum: ["base"] },
    invoiceId: { type: "string", description: "Internal purchase record id." },
    key: { type: "string", description: "The live XRPLHub API key (xrs_live_...). Shown exactly once in this response — store it immediately, it cannot be retrieved again." },
    note: { type: "string" },
  },
  required: ["status", "plan", "currency", "network", "key"],
} as const;

export function usdcPlanOutputExample(planId: PlanId) {
  return {
    status: "paid",
    plan: planId,
    currency: "USDC",
    network: "base",
    invoiceId: "clx0000000000000000000000",
    key: "xrs_live_ExampleKeyDoNotUseXXXXXXXXXXXXXXXX",
    note: "Store this key now. It cannot be shown again.",
  };
}

/**
 * Mint an API key for a paid plan and record the (already x402-verified)
 * purchase. destinationTag has no meaning here (USDC has no tag equivalent
 * and needs none — see src/lib/x402Base.ts) and is only populated to satisfy
 * the column's NOT NULL UNIQUE constraint shared with the XRPL invoice rows.
 */
export async function mintPlanKey(planId: PlanId) {
  const plan = getPlan(planId);
  const gen = generateApiKey();

  for (let i = 0; i < 3; i++) {
    try {
      const invoice = await prisma.invoice.create({
        data: {
          plan: planId,
          amountRlusd: plan.priceRlusd, // USD-denominated reference price, per schema comment
          currency: "USDC",
          destinationTag: 1 + Math.floor(Math.random() * (MAX_TAG - 1)),
          status: "paid",
          paidAt: new Date(),
          expiresAt: new Date(), // already paid; field is meaningless post-hoc
          apiKey: {
            create: {
              keyPrefix: gen.keyPrefix,
              keyHash: gen.keyHash,
              name: `invoice:usdc:${planId}`,
              plan: planId,
            },
          },
        },
      });
      return NextResponse.json({
        status: "paid",
        plan: planId,
        currency: "USDC",
        network: "base",
        invoiceId: invoice.id,
        key: gen.full, // shown ONCE
        note: "Store this key now. It cannot be shown again.",
      });
    } catch {
      /* destinationTag collision — retry a couple times, then give up */
    }
  }

  return NextResponse.json({ error: "mint_failed" }, { status: 500 });
}

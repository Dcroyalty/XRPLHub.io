// src/app/api/x402/usdc/score/route.ts
// XRPLScore over x402, priced for agents: $0.01 in USDC on Base, per call.
// This is the cheap entry point — the $29/$149/$499 routes under
// /api/checkout/usdc/{starter,growth,scale} are human subscription pricing
// and stay exactly as they are (agents buy per call, not a monthly plan).
//
// Same scoring pipeline as the RLUSD/XRPL /api/x402/score (src/lib/engine.ts
// -> src/lib/xrplscore.ts) — same mainnet nodes, same 8 signals, same 300–850
// math. A wallet gets the same score whichever rail paid for it.
import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "x402-next";
import { BASE_PAY_TO, BASE_NETWORK, PRICE_PER_SCORE_USDC, cdpFacilitator } from "@/lib/x402Base";
import { computeScore, isValidXrplAddress } from "@/lib/engine";
import { walletProp, SCORE_OUTPUT_SCHEMA } from "@/lib/scoreSchema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = async (req: NextRequest): Promise<NextResponse<unknown>> => {
  const body = (await req.json().catch(() => null)) as { wallet?: unknown } | null;
  const wallet = typeof body?.wallet === "string" ? body.wallet.trim() : "";
  if (!isValidXrplAddress(wallet)) {
    return NextResponse.json(
      { error: "bad_request", message: 'Provide a valid XRPL wallet as JSON: {"wallet":"r..."}' },
      { status: 400 }
    );
  }
  try {
    const result = await computeScore(wallet);
    return NextResponse.json({ data: result });
  } catch (err) {
    return NextResponse.json(
      { error: "scoring_failed", message: err instanceof Error ? err.message : "scoring failed" },
      { status: 500 }
    );
  }
};

export const POST = withX402(
  handler,
  BASE_PAY_TO,
  {
    price: `$${PRICE_PER_SCORE_USDC}`,
    network: BASE_NETWORK,
    config: {
      description:
        "Get a 300–850 on-chain creditworthiness score for one XRPL wallet from 8 signals (account age, " +
        "tx history, financial health, tokens, DEX, AMM, security, NFTs). $0.01 in USDC on Base per call " +
        '— the cheap entry point agents evaluate before a subscription plan. POST JSON body {"wallet":"r..."}.',
      mimeType: "application/json",
      discoverable: true,
      inputSchema: {
        bodyType: "json",
        bodyFields: { wallet: walletProp },
      },
      outputSchema: SCORE_OUTPUT_SCHEMA,
    },
  },
  cdpFacilitator
);

// src/app/.well-known/x402/route.ts
// Machine-readable x402 discovery document.
// This is how autonomous agents and x402 directories FIND XRPLHub's paid
// endpoints without a human ever telling them the URL.

import { NextResponse } from "next/server";
import {
  X402_VERSION,
  XRPL_NETWORK,
  RLUSD_ASSET,
  RLUSD_ISSUER_ADDR,
  X402_SOURCE_TAG,
  FACILITATOR_URL,
  MAX_TIMEOUT_SECONDS,
} from "@/lib/x402";
import { PRICE_PER_SCORE_RLUSD, PRICE_PER_PRODUCT_RLUSD, TREASURY_ADDRESS } from "@/lib/paycall";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const origin = new URL(req.url).origin;

  const asset = {
    asset: RLUSD_ASSET,
    assetSymbol: "RLUSD",
    issuer: RLUSD_ISSUER_ADDR,
    network: XRPL_NETWORK,
  };

  return NextResponse.json(
    {
      x402Version: X402_VERSION,
      name: "XRPLHub — XRPLScore™",
      description:
        "On-chain wallet risk scoring for the XRP Ledger. 300–850 score from 9 signals, " +
        "plus full risk reports. Pay per call in RLUSD — no account, no API key.",
      provider: { name: "XRPLHub.io", url: origin, contact: "support@xrplhub.io" },
      facilitator: FACILITATOR_URL,
      payTo: TREASURY_ADDRESS,
      resources: [
        {
          resource: `${origin}/api/x402/score`,
          method: "GET",
          description:
            "XRPLScore™ — 300–850 risk score for any XRPL wallet, with signal breakdown.",
          parameters: { wallet: "XRPL classic address (r...)" },
          scheme: "exact",
          ...asset,
          amount: PRICE_PER_SCORE_RLUSD.toFixed(6),
          maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
          extra: { sourceTag: X402_SOURCE_TAG, issuer: RLUSD_ISSUER_ADDR },
        },
        {
          resource: `${origin}/api/v1/pay-per-score`,
          method: "GET",
          description:
            "XRPLScore™ via simple destination-tag flow (no presigned blob required).",
          parameters: { wallet: "XRPL classic address (r...)" },
          scheme: "destination-tag",
          ...asset,
          amount: PRICE_PER_SCORE_RLUSD.toFixed(6),
        },
        {
          resource: `${origin}/api/v1/wallet-report`,
          method: "GET",
          description:
            "Full Wallet Risk Report — score, risk flags, weighted signals, on-chain snapshot.",
          parameters: { wallet: "XRPL classic address (r...)" },
          scheme: "destination-tag",
          ...asset,
          amount: PRICE_PER_PRODUCT_RLUSD.toFixed(6),
        },
      ],
    },
    { headers: { "Cache-Control": "public, max-age=300" } }
  );
}

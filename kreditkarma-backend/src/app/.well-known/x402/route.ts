// src/app/.well-known/x402/route.ts
// Machine-readable x402 discovery document.
// Advertises the THREE standard (PAYMENT-REQUIRED header) endpoints so
// xrpl-ai.org auto-discovery finds and lists all of them.

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
import {
  PRICE_PER_SCORE_RLUSD,
  PRICE_PER_PRODUCT_RLUSD,
  PRICE_PER_TX_PRODUCT_RLUSD,
  TREASURY_ADDRESS,
} from "@/lib/paycall";

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
        "full risk reports, and ready-to-sign prebuilt XRPL transactions. " +
        "Pay per call in RLUSD — no account, no API key.",
      provider: { name: "XRPLHub.io", url: origin, contact: "support@xrplhub.io" },
      facilitator: FACILITATOR_URL,
      network: XRPL_NETWORK,
      payTo: TREASURY_ADDRESS,
      resources: [
        {
          resource: `${origin}/api/x402/score`,
          method: "GET",
          name: "XRPLScore™ — Wallet Risk Score",
          description: "300–850 risk score for any XRPL wallet with signal breakdown.",
          scheme: "exact",
          ...asset,
          amount: PRICE_PER_SCORE_RLUSD.toFixed(6),
          maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
          extra: { sourceTag: X402_SOURCE_TAG, issuer: RLUSD_ISSUER_ADDR },
        },
        {
          resource: `${origin}/api/x402/report`,
          method: "GET",
          name: "Full Wallet Risk Report",
          description: "Score, risk flags, weighted signals, and on-chain snapshot.",
          scheme: "exact",
          ...asset,
          amount: PRICE_PER_PRODUCT_RLUSD.toFixed(6),
          maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
          extra: { sourceTag: X402_SOURCE_TAG, issuer: RLUSD_ISSUER_ADDR },
        },
        {
          resource: `${origin}/api/x402/tx`,
          method: "GET",
          name: "Prebuilt XRPL Transaction (27 services)",
          description: "Ready-to-sign XRPL transaction for any of 27 services.",
          scheme: "exact",
          ...asset,
          amount: PRICE_PER_TX_PRODUCT_RLUSD.toFixed(6),
          maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
          extra: { sourceTag: X402_SOURCE_TAG, issuer: RLUSD_ISSUER_ADDR },
        },
      ],
    },
    { headers: { "Cache-Control": "public, max-age=300" } }
  );
}

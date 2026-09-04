// src/app/openapi.json/route.ts
// OpenAPI 3.1 discovery document in x402scan's format.
// Each paid operation carries `x-payment-info` + a 402 response + an explicit
// input schema (parameters with schema+example) so the crawler knows exactly
// what to send. The discovery doc endpoint declares security:[] so it isn't
// probed as a paid product.

import { NextResponse } from "next/server";
import {
  PRICE_PER_SCORE_RLUSD,
  PRICE_PER_PRODUCT_RLUSD,
  PRICE_PER_TX_PRODUCT_RLUSD,
} from "@/lib/paycall";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function payment(amount: number, description?: string) {
  return {
    price: { mode: "fixed", currency: "USD", amount: amount.toFixed(6) },
    protocols: [{ x402: {} }],
    ...(description ? { description } : {}),
  };
}

// Explicit, unmistakable wallet parameter (schema + example + required).
function walletParam() {
  return {
    name: "wallet",
    in: "query",
    required: true,
    description: "XRPL classic address (r...) to score or report on.",
    schema: {
      type: "string",
      pattern: "^r[1-9A-HJ-NP-Za-km-z]{24,34}$",
      example: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
    },
    example: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
  };
}

const okJson = (desc: string) => ({
  description: desc,
  content: { "application/json": { schema: { type: "object" } } },
});
const resp402 = { description: "Payment Required — x402 challenge." };

export async function GET(req: Request) {
  const origin = new URL(req.url).origin;

  const doc = {
    openapi: "3.1.0",
    info: {
      title: "XRPLHub - XRPLScore and Prebuilt XRPL Transactions",
      version: "1.0.0",
      description:
        "Pay-per-call XRP Ledger services for AI agents, settled in RLUSD. " +
        "Wallet risk scores (300-850 from 8 signals), full risk reports, and " +
        "ready-to-sign prebuilt XRPL transactions across 27 services. " +
        "No account, no API key.",
      contact: { name: "XRPLHub", url: origin, email: "support@xrplhub.io" },
    },
    servers: [{ url: origin }],
    "x-service-info": {
      name: "XRPLHub - XRPLScore",
      categories: ["defi", "risk", "credit-scoring", "xrpl", "data"],
      network: "xrpl-mainnet",
      asset: {
        symbol: "RLUSD",
        code: "524C555344000000000000000000000000000000",
        issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
      },
      facilitator: "https://xrpl-facilitator-mainnet.t54.ai",
      documentation: [{ label: "Discovery", url: `${origin}/.well-known/x402` }],
    },
    paths: {
      // Free discovery doc — excluded from probing.
      "/openapi.json": {
        get: {
          operationId: "discoveryDoc",
          summary: "OpenAPI discovery document (free)",
          security: [],
          responses: { "200": okJson("This OpenAPI document.") },
        },
      },
      // STANDARD x402 endpoint — the one x402scan registers.
      "/api/x402/score": {
        get: {
          operationId: "x402Score",
          summary: "XRPLScore - wallet risk score (x402 exact scheme)",
          description:
            "300-850 risk score for any XRPL wallet with signal breakdown. " +
            "Official x402 exact scheme via t54 facilitator; pay by presigned " +
            "RLUSD payment. Send ?wallet=<r-address>.",
          tags: ["Scoring"],
          parameters: [walletParam()],
          "x-payment-info": payment(
            PRICE_PER_SCORE_RLUSD,
            "Single wallet score, RLUSD via x402 facilitator."
          ),
          responses: {
            "200": okJson("Wallet score with signals and tier."),
            "402": resp402,
          },
        },
      },
    },
  };

  return NextResponse.json(doc, { headers: { "Cache-Control": "public, max-age=300" } });
}

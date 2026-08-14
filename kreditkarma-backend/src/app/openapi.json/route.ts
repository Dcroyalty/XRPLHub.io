// src/app/openapi.json/route.ts
// OpenAPI 3.1 discovery document in x402scan's exact format.
// x402scan (and MPPScan / 402index) fetch /openapi.json to discover paid
// endpoints. Each paid operation carries an `x-payment-info` extension with
// price + protocol, plus a declared 402 response. The crawler then probes the
// runtime 402 challenge to confirm it matches.
//
// Every XRPLHub bot product is declared here so the whole catalog is
// discoverable: score (0.05), full report (0.25), prebuilt-tx (0.49), and the
// x402-standard score endpoint (facilitator/exact scheme).

import { NextResponse } from "next/server";
import {
  PRICE_PER_SCORE_RLUSD,
  PRICE_PER_PRODUCT_RLUSD,
  PRICE_PER_TX_PRODUCT_RLUSD,
} from "@/lib/paycall";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// x-payment-info price block. amount is decimal USD (RLUSD ≈ $1), string form.
function payment(amount: number, description?: string) {
  return {
    price: { mode: "fixed", currency: "USD", amount: amount.toFixed(6) },
    protocols: [{ x402: {} }],
    ...(description ? { description } : {}),
  };
}

const walletParam = {
  name: "wallet",
  in: "query",
  required: true,
  description: "XRPL classic address (r...) to score or report on.",
  schema: { type: "string", pattern: "^r[1-9A-HJ-NP-Za-km-z]{24,34}$" },
};

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
      title: "XRPLHub — XRPLScore™ & Prebuilt XRPL Transactions",
      version: "1.0.0",
      description:
        "Pay-per-call XRP Ledger services for AI agents, settled in RLUSD. " +
        "Wallet risk scores (300–850 from 9 signals), full risk reports, and " +
        "ready-to-sign prebuilt XRPL transactions across 27 services. " +
        "No account, no API key — pay per request in RLUSD on XRPL mainnet.",
      contact: { name: "XRPLHub", url: origin, email: "support@xrplhub.io" },
    },
    servers: [{ url: origin }],
    "x-service-info": {
      name: "XRPLHub — XRPLScore™",
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
      "/api/x402/score": {
        get: {
          operationId: "x402Score",
          summary: "XRPLScore™ — wallet risk score (x402 exact scheme)",
          description:
            "300–850 risk score for any XRPL wallet with signal breakdown. " +
            "Official x402 exact scheme via t54 facilitator; pay by presigned " +
            "RLUSD payment.",
          tags: ["Scoring"],
          parameters: [walletParam],
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
      "/api/v1/pay-per-score": {
        get: {
          operationId: "payPerScore",
          summary: "XRPLScore™ — wallet risk score (destination-tag flow)",
          description:
            "300–850 wallet risk score. Simple flow: GET returns a 402 with a " +
            "destination tag; pay 0.05 RLUSD; retry with &quoteId to receive the score.",
          tags: ["Scoring"],
          parameters: [walletParam],
          "x-payment-info": payment(PRICE_PER_SCORE_RLUSD, "Single wallet score."),
          responses: {
            "200": okJson("Wallet score with signals and tier."),
            "402": resp402,
          },
        },
      },
      "/api/v1/wallet-report": {
        get: {
          operationId: "walletReport",
          summary: "Full Wallet Risk Report",
          description:
            "Score plus machine-readable risk flags, weighted signal detail, and " +
            "an on-chain snapshot (balance, trust lines, activity, counterparties). " +
            "Pay 0.25 RLUSD.",
          tags: ["Reports"],
          parameters: [walletParam],
          "x-payment-info": payment(
            PRICE_PER_PRODUCT_RLUSD,
            "Full wallet risk report."
          ),
          responses: {
            "200": okJson("Full wallet risk report."),
            "402": resp402,
          },
        },
      },
      "/api/x402-tx": {
        get: {
          operationId: "prebuiltTransaction",
          summary: "Prebuilt XRPL transaction (27 services)",
          description:
            "Return a ready-to-sign XRPL transaction for any of 27 services " +
            "(CheckCreate, Escrow, NFT mint, AMM, TrustSet, DID, and more). GET " +
            "with productId + account + params, pay 0.49 RLUSD, receive txjson to " +
            "sign with your own wallet. GET with no productId returns the free catalog.",
          tags: ["Transactions"],
          parameters: [
            {
              name: "productId",
              in: "query",
              required: false,
              description:
                "Service to build (e.g. checkcreate, nftmint, escrow). Omit for the catalog.",
              schema: { type: "string" },
            },
            {
              name: "account",
              in: "query",
              required: false,
              description: "Your XRPL wallet (r...) — the signer of the returned transaction.",
              schema: { type: "string", pattern: "^r[1-9A-HJ-NP-Za-km-z]{24,34}$" },
            },
          ],
          "x-payment-info": payment(
            PRICE_PER_TX_PRODUCT_RLUSD,
            "One ready-to-sign XRPL transaction."
          ),
          responses: {
            "200": okJson("Ready-to-sign transaction (txjson) or product catalog."),
            "402": resp402,
          },
        },
      },
    },
  };

  return NextResponse.json(doc, {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}

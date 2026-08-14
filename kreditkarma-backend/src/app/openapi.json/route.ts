// src/app/openapi.json/route.ts
// OpenAPI 3.1 discovery document in x402scan's format.
// Each paid operation carries `x-payment-info` + a 402 response. The discovery
// doc endpoint itself declares security:[] so crawlers don't probe it as a
// paid product.

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

const walletParam = {
  name: "wallet", in: "query", required: true,
  description: "XRPL classic address (r...) to score or report on.",
  schema: { type: "string", pattern: "^r[1-9A-HJ-NP-Za-km-z]{24,34}$" },
  example: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
};

const okJson = (desc: string) => ({
  description: desc, content: { "application/json": { schema: { type: "object" } } },
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
        "Wallet risk scores (300-850 from 9 signals), full risk reports, and " +
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
      "/openapi.json": {
        get: {
          operationId: "discoveryDoc",
          summary: "OpenAPI discovery document (free)",
          security: [],
          responses: { "200": okJson("This OpenAPI document.") },
        },
      },
      "/api/x402/score": {
        get: {
          operationId: "x402Score",
          summary: "XRPLScore - wallet risk score (x402 exact scheme)",
          description: "300-850 risk score via t54 facilitator; pay by presigned RLUSD payment.",
          tags: ["Scoring"], parameters: [walletParam],
          "x-payment-info": payment(PRICE_PER_SCORE_RLUSD, "Single wallet score via x402 facilitator."),
          responses: { "200": okJson("Wallet score with signals and tier."), "402": resp402 },
        },
      },
      "/api/v1/pay-per-score": {
        get: {
          operationId: "payPerScore",
          summary: "XRPLScore - wallet risk score (destination-tag flow)",
          description: "300-850 score. GET returns 402 + destination tag; pay 0.05 RLUSD; retry with &wallet&quoteId.",
          tags: ["Scoring"], parameters: [walletParam],
          "x-payment-info": payment(PRICE_PER_SCORE_RLUSD, "Single wallet score."),
          responses: { "200": okJson("Wallet score with signals and tier."), "402": resp402 },
        },
      },
      "/api/v1/wallet-report": {
        get: {
          operationId: "walletReport",
          summary: "Full Wallet Risk Report",
          description: "Score plus risk flags, weighted signals, and on-chain snapshot. Pay 0.25 RLUSD.",
          tags: ["Reports"], parameters: [walletParam],
          "x-payment-info": payment(PRICE_PER_PRODUCT_RLUSD, "Full wallet risk report."),
          responses: { "200": okJson("Full wallet risk report."), "402": resp402 },
        },
      },
      "/api/x402-tx": {
        get: {
          operationId: "prebuiltTransaction",
          summary: "Prebuilt XRPL transaction (27 services)",
          description:
            "Ready-to-sign XRPL transaction for any of 27 services (CheckCreate, Escrow, NFT, AMM, TrustSet, DID...). " +
            "GET -> 402; pay 0.49 RLUSD; retry with productId + account to receive txjson. Free catalog at ?catalog=1.",
          tags: ["Transactions"],
          parameters: [
            { name: "productId", in: "query", required: false,
              description: "Service to build (checkcreate, nftmint, escrow...). Omit to default to checkcreate.",
              schema: { type: "string" }, example: "checkcreate" },
            { name: "account", in: "query", required: false,
              description: "Your XRPL wallet (r...) - the signer.",
              schema: { type: "string", pattern: "^r[1-9A-HJ-NP-Za-km-z]{24,34}$" } },
          ],
          "x-payment-info": payment(PRICE_PER_TX_PRODUCT_RLUSD, "One ready-to-sign XRPL transaction."),
          responses: { "200": okJson("Ready-to-sign transaction (txjson)."), "402": resp402 },
        },
      },
    },
  };

  return NextResponse.json(doc, { headers: { "Cache-Control": "public, max-age=300" } });
}

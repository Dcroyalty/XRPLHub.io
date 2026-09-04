// src/app/.well-known/x402/route.ts
// Machine-readable x402 discovery document.
// Advertises the THREE standard (PAYMENT-REQUIRED header) endpoints so
// xrpl-ai.org / x402scan auto-discovery finds and lists all of them — each with
// an inputSchema (every query param, its values, an example) and an
// outputSchema + outputExample so a crawler knows exactly what it gets back.

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
import { SERVICE_IDS } from "@/app/api/execute/serviceCatalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const walletProp = {
  type: "string",
  pattern: "^r[1-9A-HJ-NP-Za-km-z]{24,34}$",
  description: "XRPL classic address (r...) to score or report on.",
  example: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
};

const scoreOutputSchema = {
  type: "object",
  properties: {
    wallet: { type: "string", description: "The address that was scored." },
    score: { type: "integer", minimum: 300, maximum: 850, description: "XRPLScore, 300–850 (absolute scale)." },
    grade: { type: "string", enum: ["Building", "Fair", "Good", "Excellent", "Exceptional"] },
    percentile: { type: "number", description: "Peer percentile band, 0–100." },
    signals: {
      type: "object",
      description: "The 8 component scores, 0–100 each.",
      properties: {
        accountAge: { type: "number" }, txActivity: { type: "number" },
        financialHealth: { type: "number" }, tokenEngagement: { type: "number" },
        dexActivity: { type: "number" }, ammActivity: { type: "number" },
        securityConfig: { type: "number" }, nftActivity: { type: "number" },
      },
    },
    methodology: { type: "string" },
    computedAt: { type: "string", format: "date-time" },
  },
  required: ["wallet", "score", "grade", "signals"],
};

const scoreOutputExample = {
  wallet: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
  score: 721,
  grade: "Good",
  percentile: 74,
  signals: {
    accountAge: 88, txActivity: 71, financialHealth: 64, tokenEngagement: 61,
    dexActivity: 40, ammActivity: 12, securityConfig: 30, nftActivity: 0,
  },
  methodology: "XRPLHub XRPLScore v1.1 — 8-signal native on-chain behavioral scoring, absolute scale",
  computedAt: "2026-09-04T00:00:00.000Z",
};

export async function GET(req: Request) {
  const origin = new URL(req.url).origin;
  const asset = {
    asset: RLUSD_ASSET,
    assetSymbol: "RLUSD",
    issuer: RLUSD_ISSUER_ADDR,
    network: XRPL_NETWORK,
  };
  const common = {
    scheme: "exact",
    ...asset,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: { sourceTag: X402_SOURCE_TAG, issuer: RLUSD_ISSUER_ADDR },
    noSignup: true,
  };

  return NextResponse.json(
    {
      x402Version: X402_VERSION,
      name: "XRPLHub — XRPLScore",
      description:
        "On-chain creditworthiness scoring for the XRP Ledger. A 300–850 score from 8 signals, " +
        "full risk reports, and ready-to-sign prebuilt XRPL transactions for 35 actions. " +
        "Pay per call in RLUSD — no account, no API key, no signup.",
      provider: { name: "XRPLHub.io", url: origin, contact: "support@xrplhub.io" },
      facilitator: FACILITATOR_URL,
      network: XRPL_NETWORK,
      payTo: TREASURY_ADDRESS,
      resources: [
        {
          resource: `${origin}/api/x402/score`,
          method: "GET",
          name: "XRPLScore — wallet creditworthiness score",
          description:
            "Get a 300–850 creditworthiness score for one XRPL wallet with an 8-signal breakdown " +
            "(account age, tx history, financial health, tokens, DEX, AMM, security config, NFTs). " +
            "Use it before you pay, lend to, or onboard a wallet.",
          ...common,
          amount: PRICE_PER_SCORE_RLUSD.toFixed(6),
          inputSchema: {
            type: "object",
            properties: { wallet: walletProp },
            required: ["wallet"],
          },
          outputSchema: scoreOutputSchema,
          outputExample: scoreOutputExample,
        },
        {
          resource: `${origin}/api/x402/report`,
          method: "GET",
          name: "Full wallet risk report",
          description:
            "Get everything the score endpoint returns plus machine-readable risk flags, ranked " +
            "recommendations, and an on-chain snapshot (balance, spendable XRP, trust lines, tx " +
            "count, DEX/AMM/NFT activity, counterparties).",
          ...common,
          amount: PRICE_PER_PRODUCT_RLUSD.toFixed(6),
          inputSchema: {
            type: "object",
            properties: { wallet: walletProp },
            required: ["wallet"],
          },
          outputSchema: {
            type: "object",
            properties: {
              ...scoreOutputSchema.properties,
              riskFlags: { type: "array", items: { type: "string" }, description: "Machine-readable risk flags." },
              recommendations: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    action: { type: "string" }, points: { type: "string" },
                    priority: { type: "string", enum: ["high", "medium", "low"] },
                  },
                },
              },
              snapshot: {
                type: "object",
                properties: {
                  balanceXRP: { type: "number" }, spendableXRP: { type: "number" },
                  trustLines: { type: "integer" }, txCount: { type: "integer" },
                  hasMultiSig: { type: "boolean" }, hasOffers: { type: "boolean" }, hasAMM: { type: "boolean" },
                },
              },
            },
          },
          outputExample: {
            ...scoreOutputExample,
            riskFlags: [],
            recommendations: [
              { action: "Add 2–3 trust lines to established issuers", points: "+18", priority: "medium" },
            ],
            snapshot: {
              balanceXRP: 2500.4, spendableXRP: 2480.1, trustLines: 6, txCount: 4200,
              hasMultiSig: false, hasOffers: true, hasAMM: false,
            },
          },
        },
        {
          resource: `${origin}/api/x402/tx`,
          method: "GET",
          name: "Prebuilt XRPL transaction (35 actions)",
          description:
            "Get a ready-to-sign transaction JSON for any of 35 XRPL actions (CheckCreate, Escrow, " +
            "TrustSet, NFT mint/sell/burn, AMM, DEX order, MPT, multisig, DID, credentials, and more). " +
            "The wallet owner signs the returned txjson — this never signs for anyone.",
          ...common,
          amount: PRICE_PER_TX_PRODUCT_RLUSD.toFixed(6),
          inputSchema: {
            type: "object",
            properties: {
              productId: {
                type: "string",
                enum: SERVICE_IDS,
                description: "Which XRPL action to build. Full catalogue + per-action params at /api/mcp (list_xrpl_services).",
                example: "checkcreate",
              },
              account: {
                type: "string",
                pattern: "^r[1-9A-HJ-NP-Za-km-z]{24,34}$",
                description: "XRPL classic address that will sign the transaction.",
                example: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
              },
            },
            required: ["productId", "account"],
            additionalProperties: {
              type: "string",
              description: "Per-action parameters (e.g. destination, amount, issuer, currency, uri). See list_xrpl_services.",
            },
          },
          outputSchema: {
            type: "object",
            properties: {
              data: {
                type: "object",
                properties: {
                  productId: { type: "string" },
                  label: { type: "string" },
                  tier: { type: "string", enum: ["safe", "caution", "blocked"] },
                  txjson: { type: "object", description: "The unsigned XRPL transaction, ready for the account to sign." },
                  signWith: { type: "string" },
                  instructions: { type: "string" },
                },
              },
              x402: { type: "object", properties: { success: { type: "boolean" }, network: { type: "string" } } },
            },
          },
          outputExample: {
            data: {
              productId: "checkcreate",
              label: "Create Check",
              tier: "safe",
              txjson: {
                TransactionType: "CheckCreate",
                Account: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
                Destination: "rDest00000000000000000000000000000",
                SendMax: "10000000",
              },
              signWith: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
              instructions: "Sign this txjson with your own XRPL wallet and submit it.",
            },
            x402: { success: true, network: "xrpl" },
          },
        },
      ],
      links: {
        mcp: `${origin}/api/mcp`,
        openapi: `${origin}/openapi.json`,
        llms: `${origin}/llms.txt`,
        pricing: `${origin}/pricing`,
        freeScore: `${origin}/api/score/{wallet}`,
      },
    },
    { headers: { "Cache-Control": "public, max-age=300" } }
  );
}

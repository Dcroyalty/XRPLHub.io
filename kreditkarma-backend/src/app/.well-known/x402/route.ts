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
import { BUILDABLE_SERVICE_IDS } from "@/app/api/execute/serviceCatalog";
import { BASE_PAY_TO, BASE_NETWORK, USDC_BASE_ASSET, CDP_FACILITATOR_URL, PRICE_PER_SCORE_USDC } from "@/lib/x402Base";
import { PLANS, type PlanId } from "@/lib/plans";
import { USDC_PLAN_OUTPUT_SCHEMA, usdcPlanOutputExample } from "@/lib/checkoutUsdc";
import { walletProp, SCORE_OUTPUT_SCHEMA as scoreOutputSchema, SCORE_OUTPUT_EXAMPLE as scoreOutputExample } from "@/lib/scoreSchema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Plan-purchase resources on USDC/Base run x402 PROTOCOL VERSION 1
// (x402-next/@coinbase/x402@1.0.1 — the line the live CDP REST facilitator
// actually accepts; @x402/core's v2 payloads are rejected upstream, see
// src/lib/x402Base.ts). The 3 XRPL/RLUSD resources below run protocol
// version 2 against a different facilitator (t54) entirely. One discovery
// document CAN carry both: the official x402 discovery schema itself
// (x402/types DiscoveredResourceSchema) versions PER RESOURCE, not just at
// the document level — every resource below carries its own x402Version,
// which is authoritative. The top-level x402Version is kept only as a
// default hint for older crawlers that read just that one field.
function usdcPlanResource(origin: string, planId: PlanId) {
  const plan = PLANS[planId];
  return {
    resource: `${origin}/api/checkout/usdc/${planId}`,
    method: "GET",
    name: `${plan.name} plan — pay in USDC on Base`,
    description:
      `Buy the ${plan.name} XRPLHub API plan (${plan.monthlyQuota.toLocaleString()} scored XRPL wallet-risk ` +
      `calls/month, ${plan.rateLimitPerMin} req/min) with USDC on Base. One signed EIP-3009 authorization ` +
      `— no gas, no separate on-chain tx from you — settles immediately and returns a live API key in the ` +
      `same response. No signup, no invoice, no polling.`,
    x402Version: 1,
    scheme: "exact",
    network: BASE_NETWORK,
    asset: USDC_BASE_ASSET,
    assetSymbol: "USDC",
    payTo: BASE_PAY_TO,
    maxTimeoutSeconds: 300,
    facilitator: CDP_FACILITATOR_URL,
    noSignup: true,
    amount: plan.priceRlusd.toFixed(6),
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      description: "No parameters — the plan is fixed by the URL path.",
    },
    outputSchema: USDC_PLAN_OUTPUT_SCHEMA,
    outputExample: usdcPlanOutputExample(planId),
  };
}

// The agent-priced entry point — distinct from the 3 human subscription
// plans above. Market rate for agent-purchased calls is $0.002-$0.025;
// nothing at subscription pricing ever sells to an agent.
function usdcScoreResource(origin: string) {
  return {
    resource: `${origin}/api/x402/usdc/score`,
    method: "POST",
    name: "XRPLScore — pay per call in USDC on Base",
    description:
      "Get a 300–850 on-chain creditworthiness score for one XRPL wallet from 8 signals (account age, " +
      "tx history, financial health, tokens, DEX, AMM, security, NFTs). $0.01 in USDC on Base per call " +
      '— the cheap entry point agents evaluate before a subscription plan. POST JSON body {"wallet":"r..."}.',
    x402Version: 1,
    scheme: "exact",
    network: BASE_NETWORK,
    asset: USDC_BASE_ASSET,
    assetSymbol: "USDC",
    payTo: BASE_PAY_TO,
    maxTimeoutSeconds: 300,
    facilitator: CDP_FACILITATOR_URL,
    noSignup: true,
    amount: PRICE_PER_SCORE_USDC.toFixed(6),
    inputSchema: {
      type: "object",
      properties: { wallet: walletProp },
      required: ["wallet"],
      description: "JSON request body.",
    },
    outputSchema: scoreOutputSchema,
    outputExample: scoreOutputExample,
  };
}

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
    x402Version: 2,
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
                enum: BUILDABLE_SERVICE_IDS,
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
        usdcScoreResource(origin),
        usdcPlanResource(origin, "starter"),
        usdcPlanResource(origin, "growth"),
        usdcPlanResource(origin, "scale"),
      ],
      links: {
        mcp: `${origin}/api/mcp`,
        openapi: `${origin}/openapi.json`,
        llms: `${origin}/llms.txt`,
        pricing: `${origin}/pricing`,
        freeScore: `${origin}/api/score/{wallet}`,
        freeCredentialsAccount: `${origin}/api/credentials/account?address={wallet}`,
        freeCredentialsIssuer: `${origin}/api/credentials/issuer?address={issuer}`,
        freeDomainsEligible: `${origin}/api/domains/eligible?address={wallet}&domain={domainId}`,
      },
    },
    { headers: { "Cache-Control": "public, max-age=300" } }
  );
}

// src/app/.well-known/x402/route.ts
// Machine-readable x402 discovery document.
// Advertises every XRPL-native (PAYMENT-REQUIRED header, network xrpl:0) endpoint so
// xrpl-ai.org / x402scan auto-discovery finds and lists all of them — each with
// an inputSchema (every query param, its values, an example) and an
// outputSchema + outputExample so a crawler knows exactly what it gets back.
// Seven resources are XRPL-native: score, report, tx (XRPL only) and the four that are payable on BOTH rails
// (mpt, screen/ofac, lending/exposure, lending/underwrite — see src/lib/x402Dual.ts). The dual ones appear twice:
// once as the Base/USDC entry and once as the XRPL/RLUSD entry, for the SAME URL. The plan-purchase resources
// (checkout/usdc/*) stay Base-only, and usdc/score's XRPL twin is /api/x402/score.

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
  PRICE_PER_SCREEN_RLUSD,
  PRICE_PER_MPT_RLUSD,
  PRICE_PER_EXPOSURE_RLUSD,
  PRICE_PER_UNDERWRITE_RLUSD,
  TREASURY_ADDRESS,
} from "@/lib/paycall";
import { BUILDABLE_SERVICE_IDS, SERVICE_COUNT } from "@/app/api/execute/serviceCatalog";
import { BASE_PAY_TO, BASE_NETWORK, USDC_BASE_ASSET, CDP_FACILITATOR_URL, PRICE_PER_SCORE_USDC, PRICE_PER_MPT_USDC, PRICE_PER_SCREEN_USDC, PRICE_PER_EXPOSURE_USDC, PRICE_PER_UNDERWRITE_USDC } from "@/lib/x402Base";
import { UNDERWRITE_DISCLAIMER } from "@/lib/underwriteCanon";
import {
  SCREEN_OFAC_DESCRIPTION,
  SCREEN_OFAC_INPUT_SCHEMA,
  SCREEN_OFAC_OUTPUT_SCHEMA,
  SCREEN_OFAC_OUTPUT_EXAMPLE,
} from "@/lib/screen";
import {
  LENDING_EXPOSURE_DESCRIPTION,
  LENDING_EXPOSURE_INPUT_SCHEMA,
  LENDING_EXPOSURE_OUTPUT_SCHEMA,
} from "@/lib/lendingExposure";
import { PLANS, type PlanId } from "@/lib/plans";
import { USDC_PLAN_OUTPUT_SCHEMA, usdcPlanOutputExample } from "@/lib/checkoutUsdc";
import { walletProp, SCORE_OUTPUT_SCHEMA as scoreOutputSchema, SCORE_OUTPUT_EXAMPLE as scoreOutputExample } from "@/lib/scoreSchema";
import { SCORE_SCHEMA, REPORT_SCHEMA, TX_SCHEMA } from "@/lib/x402Schemas";
import { X402_ERROR_CODES } from "@/lib/x402";

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
    xrplEquivalent: "https://www.xrplhub.io/api/x402/score (same score, RLUSD on the XRP Ledger, $0.02)",
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

// MPT issuer risk — the paid, full-detail view. The free /api/mpt/{id}
// covers issuance facts + issuer powers + issuer score.
function usdcMptResource(origin: string) {
  return {
    resource: `${origin}/api/x402/usdc/mpt/{mptokenIssuanceID}`,
    method: "GET",
    name: "MPT issuer risk (full) — pay per call in USDC on Base",
    description:
      "Full risk view of one XLS-33 Multi-Purpose Token issuance: issuer powers (clawback, freeze, " +
      "require-auth, non-transferable) plus the issuer's XRPLScore, account age, xrp-ledger.toml-verified " +
      "domain, and credentials held. Live reads, cross-checked against Bithomp. Not found returns " +
      "'unknown', never 'does not exist'. $0.01 USDC on Base. Path segment: the 48-hex MPTokenIssuanceID.",
    x402Version: 1,
    scheme: "exact",
    network: BASE_NETWORK,
    asset: USDC_BASE_ASSET,
    assetSymbol: "USDC",
    payTo: BASE_PAY_TO,
    maxTimeoutSeconds: 300,
    facilitator: CDP_FACILITATOR_URL,
    noSignup: true,
    amount: PRICE_PER_MPT_USDC.toFixed(6),
    inputSchema: {
      type: "object",
      properties: {
        mptokenIssuanceID: {
          type: "string",
          pattern: "^[0-9A-Fa-f]{48}$",
          description: "The MPTokenIssuanceID — 48 hex chars (XLS-33 192-bit id). Passed as the last URL path segment.",
          example: "0641C7D1F9C6BB3B75EA31B353A54E2EFAC423498EF25045",
        },
      },
      required: ["mptokenIssuanceID"],
    },
    outputSchema: {
      type: "object",
      properties: {
        found: { type: "boolean" },
        source: { type: "object" },
        issuer: { type: "string" },
        issuerPowers: { type: "object" },
        issuerRisk: { type: "object" },
        related: { type: "array" },
      },
    },
  };
}

// OFAC SDN screening attestation — paid, no signup. The API-key route at
// /api/screen/ofac stays free for key holders (free tier included).
function usdcScreenResource(origin: string) {
  return {
    resource: `${origin}/api/x402/screen/ofac`,
    method: "GET",
    name: "OFAC SDN screening attestation — pay per call in USDC on Base",
    description: SCREEN_OFAC_DESCRIPTION,
    x402Version: 1,
    scheme: "exact",
    network: BASE_NETWORK,
    asset: USDC_BASE_ASSET,
    assetSymbol: "USDC",
    payTo: BASE_PAY_TO,
    maxTimeoutSeconds: 300,
    facilitator: CDP_FACILITATOR_URL,
    noSignup: true,
    amount: PRICE_PER_SCREEN_USDC.toFixed(6),
    inputSchema: {
      type: "object",
      properties: { address: SCREEN_OFAC_INPUT_SCHEMA.properties.address },
      required: ["address"],
      description: "?address=<r-address> query parameter.",
    },
    outputSchema: SCREEN_OFAC_OUTPUT_SCHEMA,
    outputExample: SCREEN_OFAC_OUTPUT_EXAMPLE,
    attestsProcessNotGroundTruth: true,
    verify: `${origin}/api/attest/verify?queryId={queryId}`,
    terms: `${origin}/legal/screening`,
  };
}

// XLS-66 cross-broker lending exposure — paid, full detail. The API-key route at
// /api/lending/exposure stays free for the aggregate (key holders, free tier ok).
function usdcExposureResource(origin: string) {
  return {
    resource: `${origin}/api/x402/lending/exposure`,
    method: "GET",
    name: "XLS-66 cross-broker lending exposure (full) — pay per call in USDC on Base",
    description: LENDING_EXPOSURE_DESCRIPTION,
    x402Version: 1,
    scheme: "exact",
    network: BASE_NETWORK,
    asset: USDC_BASE_ASSET,
    assetSymbol: "USDC",
    payTo: BASE_PAY_TO,
    maxTimeoutSeconds: 300,
    facilitator: CDP_FACILITATOR_URL,
    noSignup: true,
    amount: PRICE_PER_EXPOSURE_USDC.toFixed(6),
    inputSchema: {
      type: "object",
      properties: { borrower: LENDING_EXPOSURE_INPUT_SCHEMA.properties.borrower },
      required: ["borrower"],
      description: "?borrower=<r-address> query parameter.",
    },
    outputSchema: LENDING_EXPOSURE_OUTPUT_SCHEMA,
    attestsObservedStateNotCompleteHistory: true,
    amendmentGated: "LendingProtocol (XLS-66) — returns 503 until enabled on mainnet, then serves with no redeploy",
    verify: `${origin}/api/attest/verify?queryId={queryId}`,
  };
}

// XLS-66 underwriting-inputs bundle — the highest-value call. Facts only.
function usdcUnderwriteResource(origin: string) {
  return {
    resource: `${origin}/api/x402/lending/underwrite`,
    method: "GET",
    name: "XLS-66 underwriting inputs — full bundle, pay per call in USDC on Base",
    description:
      "Every input a LoanBroker needs for an XLS-66 underwriting decision in one call: cross-broker exposure, " +
      "XRPLScore + grade, OFAC SDN screening with its own receipt, observation history + gaps, and one " +
      "Merkle-anchored attestation over the whole bundle. FACTS ONLY — no recommended principal, rate, " +
      "approve/decline, or probability of default. The broker decides. Not lending or underwriting advice.",
    x402Version: 1,
    scheme: "exact",
    network: BASE_NETWORK,
    asset: USDC_BASE_ASSET,
    assetSymbol: "USDC",
    payTo: BASE_PAY_TO,
    maxTimeoutSeconds: 300,
    facilitator: CDP_FACILITATOR_URL,
    noSignup: true,
    amount: PRICE_PER_UNDERWRITE_USDC.toFixed(6),
    inputSchema: {
      type: "object",
      properties: {
        borrower: { type: "string", pattern: "^r[1-9A-HJ-NP-Za-km-z]{24,34}$", description: "the borrower's XRPL address" },
      },
      required: ["borrower"],
    },
    factsOnlyNoRecommendation: true,
    amendmentGated: "LendingProtocol (XLS-66) — 503 (with the live XRPLScore + OFAC result) until enabled on mainnet",
    verify: `${origin}/api/attest/verify?queryId={queryId}`,
    disclaimer: UNDERWRITE_DISCLAIMER,
  };
}

const MPT_XRPL_DESCRIPTION =
  "Full risk view of one XLS-33 Multi-Purpose Token issuance: issuer powers (clawback, freeze, " +
  "require-auth, non-transferable) plus the issuer's XRPLScore, account age, xrp-ledger.toml-verified " +
  "domain, and credentials held. Live reads, cross-checked against Bithomp. Not found returns " +
  "'unknown', never 'does not exist'. Path segment: the 48-hex MPTokenIssuanceID.";

const UNDERWRITE_XRPL_DESCRIPTION =
  "Every input a LoanBroker needs for an XLS-66 underwriting decision in one call: cross-broker exposure, " +
  "XRPLScore + grade, OFAC SDN screening with its own receipt, observation history + gaps, and one " +
  "Merkle-anchored attestation over the whole bundle. FACTS ONLY — no recommended principal, rate, " +
  "approve/decline, or probability of default. The broker decides. Not lending or underwriting advice.";

const MPT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    mptokenIssuanceID: {
      type: "string",
      pattern: "^[0-9A-Fa-f]{48}$",
      description: "The MPTokenIssuanceID — 48 hex chars (XLS-33 192-bit id). Passed as the last URL path segment.",
      example: "0641C7D1F9C6BB3B75EA31B353A54E2EFAC423498EF25045",
    },
  },
  required: ["mptokenIssuanceID"],
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
    x402Version: 2,
  };

  return NextResponse.json(
    {
      x402Version: X402_VERSION,
      name: "XRPLHub — XRPLScore",
      description:
        "On-chain creditworthiness scoring for the XRP Ledger. A 300–850 score from 8 signals, " +
        "full risk reports, and ready-to-sign prebuilt XRPL transactions for " + SERVICE_COUNT + " actions. " +
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
          inputSchema: SCORE_SCHEMA.input,
          outputSchema: SCORE_SCHEMA.output,
          outputExample: SCORE_SCHEMA.outputExample,
        },
        {
          resource: `${origin}/api/x402/report`,
          method: "GET",
          name: "Full wallet risk report",
          description: REPORT_SCHEMA.description,
          ...common,
          amount: PRICE_PER_PRODUCT_RLUSD.toFixed(6),
          inputSchema: REPORT_SCHEMA.input,
          outputSchema: REPORT_SCHEMA.output,
          outputExample: REPORT_SCHEMA.outputExample,
        },
        {
          resource: `${origin}/api/x402/tx`,
          method: "GET",
          name: "Prebuilt XRPL transaction (" + SERVICE_COUNT + " actions)",
          description: TX_SCHEMA.description,
          ...common,
          amount: PRICE_PER_TX_PRODUCT_RLUSD.toFixed(6),
          inputSchema: TX_SCHEMA.input,
          outputSchema: TX_SCHEMA.output,
          outputExample: TX_SCHEMA.outputExample,
        },
        // XRPL twins of the four dual-rail resources (same URL as the Base entries further down; same face value).
        {
          resource: `${origin}/api/x402/usdc/mpt/{mptokenIssuanceID}`,
          method: "GET",
          name: "MPT issuer risk (full)",
          description: MPT_XRPL_DESCRIPTION,
          ...common,
          amount: PRICE_PER_MPT_RLUSD.toFixed(6),
          inputSchema: MPT_INPUT_SCHEMA,
        },
        {
          resource: `${origin}/api/x402/screen/ofac`,
          method: "GET",
          name: "OFAC SDN screening attestation",
          description: SCREEN_OFAC_DESCRIPTION,
          ...common,
          amount: PRICE_PER_SCREEN_RLUSD.toFixed(6),
          inputSchema: {
            type: "object",
            properties: { address: SCREEN_OFAC_INPUT_SCHEMA.properties.address },
            required: ["address"],
            description: "?address=<r-address> query parameter.",
          },
          outputSchema: SCREEN_OFAC_OUTPUT_SCHEMA,
          outputExample: SCREEN_OFAC_OUTPUT_EXAMPLE,
          attestsProcessNotGroundTruth: true,
          verify: `${origin}/api/attest/verify?queryId={queryId}`,
          terms: `${origin}/legal/screening`,
        },
        {
          resource: `${origin}/api/x402/lending/exposure`,
          method: "GET",
          name: "XLS-66 cross-broker lending exposure (full)",
          description: LENDING_EXPOSURE_DESCRIPTION,
          ...common,
          amount: PRICE_PER_EXPOSURE_RLUSD.toFixed(6),
          inputSchema: {
            type: "object",
            properties: { borrower: LENDING_EXPOSURE_INPUT_SCHEMA.properties.borrower },
            required: ["borrower"],
            description: "?borrower=<r-address> query parameter.",
          },
          outputSchema: LENDING_EXPOSURE_OUTPUT_SCHEMA,
          attestsObservedStateNotCompleteHistory: true,
          amendmentGated: "LendingProtocol (XLS-66) — returns 503 (error amendment_not_active, not charged) until enabled on mainnet",
          verify: `${origin}/api/attest/verify?queryId={queryId}`,
        },
        {
          resource: `${origin}/api/x402/lending/underwrite`,
          method: "GET",
          name: "XLS-66 underwriting inputs (full bundle)",
          description: UNDERWRITE_XRPL_DESCRIPTION,
          ...common,
          amount: PRICE_PER_UNDERWRITE_RLUSD.toFixed(6),
          inputSchema: {
            type: "object",
            properties: {
              borrower: { type: "string", pattern: "^r[1-9A-HJ-NP-Za-km-z]{24,34}$", description: "the borrower's XRPL address" },
            },
            required: ["borrower"],
          },
          factsOnlyNoRecommendation: true,
          amendmentGated: "LendingProtocol (XLS-66) — 503 (error amendment_not_active, not charged) until enabled on mainnet",
          verify: `${origin}/api/attest/verify?queryId={queryId}`,
          disclaimer: UNDERWRITE_DISCLAIMER,
        },
        usdcScoreResource(origin),
        usdcMptResource(origin),
        usdcScreenResource(origin),
        usdcExposureResource(origin),
        usdcUnderwriteResource(origin),
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
        freeMptRisk: `${origin}/api/mpt/{mptokenIssuanceID}`,
        health: `${origin}/api/health`,
        freeMptSearch: `${origin}/api/mpt/search?q={query}`,
        freeMptIssuer: `${origin}/api/mpt/issuer?address={issuer}`,
        freeMptAnchor: `${origin}/api/mpt/anchor`,
        ofacScreenWithApiKey: `${origin}/api/screen/ofac?address={wallet}`,
        screeningVerify: `${origin}/api/attest/verify?queryId={queryId}`,
        screeningSpec: `${origin}/api/attest/anchor`,
        screeningTerms: `${origin}/legal/screening`,
        lendingExposureAggregateWithApiKey: `${origin}/api/lending/exposure?borrower={wallet}`,
        lendingHistoryWithApiKey: `${origin}/api/lending/history?borrower={wallet}`,
        lendingAttestationVerify: `${origin}/api/attest/verify?queryId={queryId}`,
        // Continuous monitoring is API-key based (not pay-per-call x402): a key + a consumer-use acknowledgement + a webhook.
        monitoringInfo: `${origin}/api/monitor`,
        monitoringSubscribeWithApiKey: `${origin}/api/monitor/subscribe`,
        monitoringHistoryWithApiKey: `${origin}/api/monitor/history?subject={wallet}`,
        monitoringEventsWithApiKey: `${origin}/api/monitor/events`,
      },
      // Stable machine-readable error codes returned by the RLUSD/t54 paid
      // routes. `error` is always one of these keys; the value describes it.
      errorCodes: X402_ERROR_CODES,
      guarantees: {
        settlement: "On /api/x402/{score,report,tx} and on the XRPL rail of the dual-rail routes (mpt, screen/ofac, lending/exposure, lending/underwrite): the on-ledger payment settles ONLY after the paid work returns success. A handler failure returns error:handler_failed and does NOT charge you — retry with the same PAYMENT-SIGNATURE within maxTimeoutSeconds.",
        idempotency: "Send an Idempotency-Key header (or rely on the payment's invoiceId). A retried request replays the original response — you can never pay twice.",
      },
    },
    { headers: { "Cache-Control": "public, max-age=300" } }
  );
}

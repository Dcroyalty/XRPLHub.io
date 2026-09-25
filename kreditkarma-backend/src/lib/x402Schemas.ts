// src/lib/x402Schemas.ts
// One source of truth for the three RLUSD/t54 paid resources' input + output
// schemas, so the live 402 challenge and the .well-known/x402 discovery
// document describe the SAME thing. Every `description` here is < 480 chars.

import { walletProp, SCORE_OUTPUT_SCHEMA, SCORE_OUTPUT_EXAMPLE } from "./scoreSchema";
import { BUILDABLE_SERVICE_IDS, SERVICE_COUNT } from "@/app/api/execute/serviceCatalog";
import { SERVICE_PRICE_USD } from "@/lib/servicePrices";

const TX_PRICES = BUILDABLE_SERVICE_IDS.map((id) => SERVICE_PRICE_USD[id]).filter((n): n is number => typeof n === "number");
const TX_MIN_USD = Math.min(...TX_PRICES);
const TX_MAX_USD = Math.max(...TX_PRICES);

export interface X402ResourceSchema {
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  outputExample: Record<string, unknown>;
  /** < 480 chars — mirrored into the challenge and the discovery doc. */
  description: string;
}

export const SCORE_SCHEMA: X402ResourceSchema = {
  description:
    "300–850 on-chain creditworthiness score for one XRPL wallet with the 8-signal breakdown " +
    "(account age, tx history, financial health, tokens, DEX, AMM, security config, NFTs). One RLUSD " +
    "payment = one score. No account, no key.",
  input: {
    type: "object",
    properties: { wallet: walletProp },
    required: ["wallet"],
  },
  output: SCORE_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
  outputExample: SCORE_OUTPUT_EXAMPLE,
};

export const REPORT_SCHEMA: X402ResourceSchema = {
  description:
    "Everything the score returns plus machine-readable risk flags, ranked recommendations, and an " +
    "on-chain snapshot (balance, spendable XRP, trust lines, tx count, DEX/AMM/NFT activity). One RLUSD " +
    "payment = one report.",
  input: {
    type: "object",
    properties: { wallet: walletProp },
    required: ["wallet"],
  },
  output: {
    type: "object",
    properties: {
      ...(SCORE_OUTPUT_SCHEMA.properties as Record<string, unknown>),
      riskFlags: { type: "array", items: { type: "string" }, description: "Machine-readable risk flags." },
      recommendations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            action: { type: "string" },
            points: { type: "string" },
            priority: { type: "string", enum: ["high", "medium", "low"] },
          },
        },
      },
      snapshot: {
        type: "object",
        properties: {
          balanceXRP: { type: "number" },
          spendableXRP: { type: "number" },
          trustLines: { type: "integer" },
          txCount: { type: "integer" },
          hasMultiSig: { type: "boolean" },
          hasOffers: { type: "boolean" },
          hasAMM: { type: "boolean" },
        },
      },
    },
    required: ["wallet", "score", "grade", "signals", "disclaimer", "dataCompleteness"],
  },
  outputExample: {
    ...SCORE_OUTPUT_EXAMPLE,
    riskFlags: [],
    recommendations: [{ action: "Add 2–3 trust lines to established issuers", points: "+18", priority: "medium" }],
    snapshot: { balanceXRP: 2500.4, spendableXRP: 2480.1, trustLines: 6, txCount: 4200, hasMultiSig: false, hasOffers: true, hasAMM: false },
  },
};

export const TX_SCHEMA: X402ResourceSchema = {
  description:
    "The signable XRPL transaction JSON for any of " + SERVICE_COUNT + " actions (CheckCreate, Escrow, TrustSet, NFT, " +
    "AMM, DEX order, MPT, multisig, DID, credentials, and more), delivered after payment. Priced per action at the storefront price ($" + TX_MIN_USD + "–$" + TX_MAX_USD + "; " +
    "/api/pricing). Pay USDC on Base or RLUSD on XRPL. You sign with your own wallet. Caution-tier actions need confirmCaution=true. Free preview: MCP preview_xrpl_transaction.",
  input: {
    type: "object",
    properties: {
      productId: {
        type: "string",
        enum: BUILDABLE_SERVICE_IDS,
        description: "Which XRPL action to build. Full catalogue + per-action params: /api/mcp list_xrpl_services.",
        example: "checkcreate",
      },
      account: {
        type: "string",
        pattern: "^r[1-9A-HJ-NP-Za-km-z]{24,34}$",
        description: "XRPL classic address that will sign the returned transaction.",
        example: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
      },
      confirmCaution: {
        type: "string",
        enum: ["true"],
        description: "Caution-tier actions (multisig lockdown, No Freeze, MPT issuance, …) are refused unpaid with the irreversibility copy until the wallet owner has read it; then repeat with confirmCaution=true.",
      },
    },
    required: ["productId", "account"],
    // (confirmCaution is declared below in `properties` for caution-tier actions)
    additionalProperties: {
      type: "string",
      description: "Per-action parameters (destination, amount, issuer, currency, uri, ...). See list_xrpl_services.",
    },
  },
  output: {
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
      x402: { type: "object", properties: { success: { type: "boolean" }, settled: { type: "boolean" }, transaction: { type: "string" }, network: { type: "string" } } },
    },
  },
  outputExample: {
    data: { productId: "checkcreate", label: "Create Check", tier: "safe", txjson: { TransactionType: "CheckCreate" }, signWith: "the account's own wallet", instructions: "Sign this in your XRPL wallet." },
    x402: { success: true, settled: true, transaction: "F0D0…", network: "xrpl" },
  },
};

// src/lib/x402Schemas.ts
// One source of truth for the three RLUSD/t54 paid resources' input + output
// schemas, so the live 402 challenge and the .well-known/x402 discovery
// document describe the SAME thing. Every `description` here is < 480 chars.

import { walletProp, SCORE_OUTPUT_SCHEMA, SCORE_OUTPUT_EXAMPLE } from "./scoreSchema";

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
    "(account age, tx history, financial health, tokens, DEX, AMM, security config, NFTs). One payment " +
    "(RLUSD on XRPL or USDC on Base, same price) = one score. No account, no key.",
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
    "on-chain snapshot (balance, spendable XRP, trust lines, tx count, DEX/AMM/NFT activity). One payment " +
    "(RLUSD on XRPL or USDC on Base, same price) = one report.",
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


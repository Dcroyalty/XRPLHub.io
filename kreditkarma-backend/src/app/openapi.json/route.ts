// src/app/openapi.json/route.ts
// OpenAPI 3.1 discovery document in x402scan's format.
// Every paid operation carries `x-payment-info`, a 402 response, an explicit
// input schema (params with schema + example), and a real 200 response schema
// with an example so a crawler knows exactly what to send AND what it gets back.
// The discovery doc endpoint declares security:[] so it isn't probed as a paid product.

import { NextResponse } from "next/server";
import {
  PRICE_PER_SCORE_RLUSD,
  PRICE_PER_PRODUCT_RLUSD,
  PRICE_PER_TX_PRODUCT_RLUSD,
} from "@/lib/paycall";
import { BUILDABLE_SERVICE_IDS } from "@/app/api/execute/serviceCatalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function payment(amount: number, description: string) {
  return {
    price: { mode: "fixed", currency: "USD", amount: amount.toFixed(6) },
    protocols: [{ x402: {} }],
    description,
  };
}

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

const SIGNALS = [
  "accountAge", "txActivity", "financialHealth", "tokenEngagement",
  "dexActivity", "ammActivity", "securityConfig", "nftActivity",
];

const scoreSchema = {
  type: "object",
  properties: {
    wallet: { type: "string" },
    score: { type: "integer", minimum: 300, maximum: 850, description: "XRPLScore, 300–850 absolute scale." },
    grade: { type: "string", enum: ["Building", "Fair", "Good", "Excellent", "Exceptional"] },
    percentile: { type: "number" },
    signals: {
      type: "object",
      description: "The 8 component scores, 0–100 each.",
      properties: Object.fromEntries(SIGNALS.map((k) => [k, { type: "number" }])),
    },
    methodology: { type: "string" },
    computedAt: { type: "string", format: "date-time" },
  },
  required: ["wallet", "score", "grade", "signals"],
};

const scoreExample = {
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

const ok = (description: string, schema: object, example: object) => ({
  description,
  content: { "application/json": { schema, example } },
});
const resp402 = {
  description: "Payment Required — x402 challenge. Body is the PAYMENT-REQUIRED payload; pay in RLUSD and retry with the PAYMENT-SIGNATURE header.",
};

export async function GET(req: Request) {
  const origin = new URL(req.url).origin;

  const doc = {
    openapi: "3.1.0",
    info: {
      title: "XRPLHub — XRPLScore and Prebuilt XRPL Transactions",
      version: "1.1.0",
      description:
        "Pay-per-call XRP Ledger services for AI agents, settled in RLUSD. " +
        "A 300–850 wallet creditworthiness score from 8 signals, full risk reports, and " +
        "ready-to-sign prebuilt XRPL transactions for 35 actions. No account, no API key, no signup. " +
        "A free (unauthenticated) score is also at GET /api/score/{wallet}.",
      contact: { name: "XRPLHub", url: origin, email: "support@xrplhub.io" },
    },
    servers: [{ url: origin }],
    "x-service-info": {
      name: "XRPLHub — XRPLScore",
      categories: ["defi", "risk", "credit-scoring", "xrpl", "data"],
      network: "xrpl-mainnet",
      asset: {
        symbol: "RLUSD",
        code: "524C555344000000000000000000000000000000",
        issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
      },
      facilitator: "https://xrpl-facilitator-mainnet.t54.ai",
      noSignup: true,
      documentation: [
        { label: "x402 discovery", url: `${origin}/.well-known/x402` },
        { label: "MCP server", url: `${origin}/api/mcp` },
        { label: "llms.txt", url: `${origin}/llms.txt` },
        { label: "Pricing", url: `${origin}/pricing` },
      ],
    },
    paths: {
      "/openapi.json": {
        get: {
          operationId: "discoveryDoc",
          summary: "OpenAPI discovery document (free)",
          security: [],
          responses: { "200": { description: "This OpenAPI document." } },
        },
      },

      "/api/score/{wallet}": {
        get: {
          operationId: "freeScore",
          summary: "XRPLScore — wallet creditworthiness score (free, unauthenticated)",
          description:
            "Get a 300–850 creditworthiness score for one XRPL wallet with the 8-signal breakdown. " +
            "Free, no key, no signup. Same number the paid endpoints and the public site return.",
          security: [],
          parameters: [{
            name: "wallet", in: "path", required: true,
            description: "XRPL classic address (r...).",
            schema: { type: "string", pattern: "^r[1-9A-HJ-NP-Za-km-z]{24,34}$" },
            example: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
          }],
          responses: {
            "200": ok("Wallet score with the 8 signals, grade and percentile.", scoreSchema, scoreExample),
            "404": { description: "Address is not an activated XRPL mainnet account." },
          },
        },
      },

      "/api/x402/score": {
        get: {
          operationId: "x402Score",
          summary: "XRPLScore — wallet creditworthiness score (x402 exact scheme)",
          description:
            "Get a 300–850 creditworthiness score for one XRPL wallet with an 8-signal breakdown. " +
            "Official x402 exact scheme via the t54 facilitator; pay by presigned RLUSD payment. " +
            "Send ?wallet=<r-address>. No signup.",
          tags: ["Scoring"],
          parameters: [walletParam()],
          "x-payment-info": payment(PRICE_PER_SCORE_RLUSD, "Single wallet score, RLUSD via x402 facilitator."),
          responses: {
            "200": ok("Wallet score with the 8 signals, grade and percentile.", scoreSchema, scoreExample),
            "402": resp402,
          },
        },
      },

      "/api/x402/report": {
        get: {
          operationId: "x402Report",
          summary: "Full wallet risk report (x402 exact scheme)",
          description:
            "Everything the score endpoint returns plus machine-readable risk flags, ranked " +
            "recommendations, and an on-chain snapshot (balance, spendable XRP, trust lines, tx " +
            "count, DEX/AMM/NFT activity). Send ?wallet=<r-address>. No signup.",
          tags: ["Scoring"],
          parameters: [walletParam()],
          "x-payment-info": payment(PRICE_PER_PRODUCT_RLUSD, "Full risk report for one wallet, RLUSD via x402 facilitator."),
          responses: {
            "200": ok(
              "Full risk report.",
              {
                type: "object",
                properties: {
                  ...scoreSchema.properties,
                  riskFlags: { type: "array", items: { type: "string" } },
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
              {
                ...scoreExample,
                riskFlags: [],
                recommendations: [
                  { action: "Add 2–3 trust lines to established issuers", points: "+18", priority: "medium" },
                ],
                snapshot: {
                  balanceXRP: 2500.4, spendableXRP: 2480.1, trustLines: 6, txCount: 4200,
                  hasMultiSig: false, hasOffers: true, hasAMM: false,
                },
              }
            ),
            "402": resp402,
          },
        },
      },

      "/api/x402/tx": {
        get: {
          operationId: "x402Tx",
          summary: "Prebuilt XRPL transaction — 35 actions (x402 exact scheme)",
          description:
            "Get a ready-to-sign transaction JSON for any of 35 XRPL actions (CheckCreate, Escrow, " +
            "TrustSet, NFT mint/sell/burn, AMM create/deposit, DEX order, MPT issue/send, multisig, " +
            "DID, credentials, permissioned domains, and more). The wallet owner signs the returned " +
            "txjson — this never signs for anyone. No signup.",
          tags: ["Transactions"],
          parameters: [
            {
              name: "productId", in: "query", required: true,
              description: "Which XRPL action to build. Full catalogue + per-action params at /api/mcp (list_xrpl_services).",
              schema: { type: "string", enum: BUILDABLE_SERVICE_IDS, example: "checkcreate" },
              example: "checkcreate",
            },
            {
              name: "account", in: "query", required: true,
              description: "XRPL classic address that will sign the transaction.",
              schema: { type: "string", pattern: "^r[1-9A-HJ-NP-Za-km-z]{24,34}$" },
              example: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De",
            },
            {
              name: "<action params>", in: "query", required: false,
              description: "Per-action params as query args, e.g. destination, amount, issuer, currency, uri, finishAfter. See list_xrpl_services for the fields each productId needs.",
              schema: { type: "string" },
            },
          ],
          "x-payment-info": payment(PRICE_PER_TX_PRODUCT_RLUSD, "One prebuilt XRPL transaction, RLUSD via x402 facilitator."),
          responses: {
            "200": ok(
              "The unsigned transaction, ready for `account` to sign.",
              {
                type: "object",
                properties: {
                  data: {
                    type: "object",
                    properties: {
                      productId: { type: "string" },
                      label: { type: "string" },
                      tier: { type: "string", enum: ["safe", "caution", "blocked"] },
                      txjson: { type: "object" },
                      signWith: { type: "string" },
                      instructions: { type: "string" },
                    },
                  },
                  x402: { type: "object", properties: { success: { type: "boolean" }, network: { type: "string" } } },
                },
              },
              {
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
              }
            ),
            "402": resp402,
            "422": { description: "Payment received but required action params were missing — retry with them." },
          },
        },
      },

      "/api/credentials/account": {
        get: {
          operationId: "credentialsAccount",
          summary: "Every XLS-70 credential an account holds (free, live)",
          description:
            "Get every credential naming this address as Subject — issuer, type, whether it's been " +
            "accepted, whether it's expired, and its expiry date. Live against a validated mainnet " +
            "ledger on every call, deliberately not cached: this is the endpoint to check before " +
            "trusting a counterparty's claimed credential. Free, no signup.",
          security: [],
          tags: ["Credentials"],
          parameters: [{
            name: "address", in: "query", required: true,
            description: "XRPL classic address to look up (r...).",
            schema: { type: "string", pattern: "^r[1-9A-HJ-NP-Za-km-z]{24,34}$" },
            example: "rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B",
          }],
          responses: {
            "200": ok(
              "Every credential held by this address.",
              {
                type: "object",
                properties: {
                  address: { type: "string" },
                  source: { type: "string", enum: ["live"] },
                  count: { type: "integer" },
                  credentials: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        issuer: { type: "string" },
                        credentialType: { type: "string" },
                        credentialTypeHex: { type: "string" },
                        accepted: { type: "boolean" },
                        expired: { type: "boolean" },
                        expirationISO: { type: "string", format: "date-time", nullable: true },
                        uri: { type: "string", nullable: true },
                      },
                    },
                  },
                },
              },
              {
                address: "rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B",
                source: "live",
                count: 1,
                credentials: [{
                  issuer: "rmWjCGeLtuLGerEuvHDkrsr46ej2Ni13f",
                  credentialType: "io.xrplhub.score.v1.min750",
                  credentialTypeHex: "696F2E7872706C6875622E73636F72652E76312E6D696E373530",
                  accepted: false, expired: false,
                  expirationISO: "2026-12-03T10:59:55.000Z", uri: "https://www.xrplhub.io/verify/wallet/rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B",
                }],
              }
            ),
            "400": { description: "Missing or invalid address." },
          },
        },
      },

      "/api/credentials/issuer": {
        get: {
          operationId: "credentialsIssuer",
          summary: "Everything an issuer has issued (free, census-backed)",
          description:
            "Every credential type an issuer has issued, distinct subject count, and acceptance rate. " +
            "Served from a network-wide census rebuilt on a schedule, not live — the response's " +
            "`coverage` field is \"complete\" or \"partial\" so a mid-walk answer is never presented " +
            "as a finished count. Free, no signup.",
          security: [],
          tags: ["Credentials"],
          parameters: [{
            name: "address", in: "query", required: true,
            description: "XRPL classic address of the issuer (r...).",
            schema: { type: "string", pattern: "^r[1-9A-HJ-NP-Za-km-z]{24,34}$" },
            example: "rmWjCGeLtuLGerEuvHDkrsr46ej2Ni13f",
          }],
          responses: {
            "200": ok(
              "Issuer stats from the census.",
              {
                type: "object",
                properties: {
                  address: { type: "string" },
                  source: { type: "string", enum: ["indexed"] },
                  coverage: { type: "string", enum: ["complete", "partial"] },
                  lastCompletedPassAt: { type: "string", format: "date-time", nullable: true },
                  totalIssued: { type: "integer" },
                  subjectCount: { type: "integer" },
                  acceptanceRate: { type: "number", nullable: true },
                  types: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        credentialType: { type: "string" }, credentialTypeHex: { type: "string" }, count: { type: "integer" },
                      },
                    },
                  },
                },
              },
              {
                address: "rmWjCGeLtuLGerEuvHDkrsr46ej2Ni13f",
                source: "indexed", coverage: "complete", lastCompletedPassAt: "2026-09-05T12:00:00.000Z",
                totalIssued: 1, subjectCount: 1, acceptanceRate: 0,
                types: [{ credentialType: "io.xrplhub.score.v1.min750", credentialTypeHex: "696F2E7872706C6875622E73636F72652E76312E6D696E373530", count: 1 }],
              }
            ),
            "400": { description: "Missing or invalid address." },
          },
        },
      },

      "/api/domains/eligible": {
        get: {
          operationId: "domainsEligible",
          summary: "Does this account satisfy this PermissionedDomain? (free, live)",
          description:
            "Checks whether an account holds an accepted, unexpired credential matching any entry in a " +
            "PermissionedDomain's AcceptedCredentials (XLS-80d: OR semantics — one matching credential " +
            "is enough). Live against a validated mainnet ledger on every call. Free, no signup.",
          security: [],
          tags: ["Credentials"],
          parameters: [
            {
              name: "address", in: "query", required: true,
              description: "XRPL classic address to check (r...).",
              schema: { type: "string", pattern: "^r[1-9A-HJ-NP-Za-km-z]{24,34}$" },
              example: "rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B",
            },
            {
              name: "domain", in: "query", required: true,
              description: "The PermissionedDomain's own ledger index (DomainID) — 64 hex characters.",
              schema: { type: "string", pattern: "^[0-9A-Fa-f]{64}$" },
            },
          ],
          responses: {
            "200": ok(
              "Eligibility result.",
              {
                type: "object",
                properties: {
                  address: { type: "string" },
                  domain: { type: "string" },
                  domainFound: { type: "boolean" },
                  domainOwner: { type: "string", nullable: true },
                  eligible: { type: "boolean" },
                  reason: { type: "string" },
                  satisfiedBy: { type: "object", nullable: true },
                  acceptedCredentials: { type: "array", items: { type: "object" } },
                  heldCredentials: { type: "array", items: { type: "object" } },
                },
              },
              {
                address: "rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B",
                domain: "0000000000000000000000000000000000000000000000000000000000000000",
                domainFound: false, domainOwner: null, eligible: false,
                reason: "No PermissionedDomain exists at that DomainID on the validated ledger.",
                satisfiedBy: null, acceptedCredentials: [], heldCredentials: [],
              }
            ),
            "400": { description: "Missing or invalid address/domain." },
          },
        },
      },
    },
  };

  return NextResponse.json(doc, { headers: { "Cache-Control": "public, max-age=300" } });
}

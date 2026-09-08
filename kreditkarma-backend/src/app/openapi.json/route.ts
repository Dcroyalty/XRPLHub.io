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
import { SCREEN_OFAC_OUTPUT_SCHEMA, SCREEN_OFAC_OUTPUT_EXAMPLE } from "@/lib/screen";
import { LENDING_EXPOSURE_OUTPUT_SCHEMA } from "@/lib/lendingExposure";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const screenOutputSchema = SCREEN_OFAC_OUTPUT_SCHEMA as unknown as object;
const screenOutputExample = SCREEN_OFAC_OUTPUT_EXAMPLE as unknown as object;
const exposureOutputSchema = LENDING_EXPOSURE_OUTPUT_SCHEMA as unknown as object;
const screenAddrParam = {
  name: "address",
  in: "query" as const,
  required: true,
  description: "XRPL classic address (r...) to compare against the OFAC SDN list.",
  schema: { type: "string", pattern: "^r[1-9A-HJ-NP-Za-km-z]{24,34}$" },
  example: "rnXyVQzgxZe7TR1EPzTkGj2jxH4LMJYh66",
};
const borrowerParam = {
  name: "borrower",
  in: "query" as const,
  required: true,
  description: "XRPL classic address (r...) of the borrower to aggregate lending exposure for.",
  schema: { type: "string", pattern: "^r[1-9A-HJ-NP-Za-km-z]{24,34}$" },
  example: "rEjXbJh2hwn2SVME1EvdCiH6TnU5TEpvf",
};

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
    disclaimer: {
      type: "string",
      description:
        "Always present. XRPLScore is informational only — NOT a FICO score, consumer report, or NRSRO " +
        "rating, and not permissible for FCRA- or ECOA-governed decisions.",
    },
    dataCompleteness: {
      type: "object",
      description:
        "`complete` is always true on a 200. If any XRPL call cannot be read the endpoint returns 503 " +
        "(error \"xrpl_unavailable\", with failedCalls) and NO score — a failed read is never folded into a signal.",
      properties: {
        complete: { type: "boolean" },
        unread: { type: "array", items: { type: "string" } },
        source: { type: "string" },
      },
    },
    computedAt: { type: "string", format: "date-time" },
  },
  required: ["wallet", "score", "grade", "signals", "disclaimer", "dataCompleteness"],
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
  disclaimer:
    "XRPLScore is an informational analytics signal computed only from public XRP Ledger data. It is NOT a " +
    "FICO score, a consumer credit score, a consumer report, or an NRSRO rating, and must not be used for any " +
    "purpose governed by the U.S. Fair Credit Reporting Act or the Equal Credit Opportunity Act.",
  dataCompleteness: { complete: true, unread: [], source: "xrpl-mainnet-jsonrpc (xrplcluster → s1 → s2)" },
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
        "A free (unauthenticated) score is also at GET /api/score/{wallet}.\n\n" +
        "AGENT SAFETY on /api/x402/{score,report,tx}: the on-ledger payment settles ONLY after the paid " +
        "work returns success — a handler failure returns `error: \"handler_failed\"` and does NOT charge " +
        "you (retry with the same PAYMENT-SIGNATURE within maxTimeoutSeconds). Send an `Idempotency-Key` " +
        "header (or rely on the payment invoiceId) — a retried request replays the original response, so " +
        "you can never pay twice. Every failure `error` is one of the codes in /.well-known/x402 " +
        "`errorCodes`.\n\n" +
        "RETIRED (HTTP 410 — use the x402 route in `useInstead`): /api/x402-tx -> /api/x402/tx; " +
        "/api/v1/wallet-report -> /api/x402/report; /api/v1/pay-per-score -> /api/x402/score.\n\n" +
        "OFAC SDN SCREENING (/api/screen/ofac, /api/x402/screen/ofac): attests to PROCESS, not ground " +
        "truth. A receipt records that an address was compared against a named, hash-pinned OFAC SDN " +
        "snapshot at a stated time and what the comparison found. It never states that any address or " +
        "person is sanctioned, clean, or risky, is not legal/compliance advice, and does not discharge " +
        "your own screening obligations. Every receipt is Merkle-anchored on-ledger; verify at " +
        "/api/attest/verify?queryId=. Terms: /legal/screening.",
      contact: { name: "XRPLHub", url: origin, email: "support@xrplhub.io" },
    },
    servers: [{ url: origin }],
    "x-service-info": {
      name: "XRPLHub — XRPLScore",
      categories: ["defi", "risk", "credit-scoring", "xrpl", "data", "compliance", "sanctions-screening", "lending", "credit-bureau"],
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
            "trusting a counterparty's claimed credential. Free, no signup. " +
            "Default is an owner-directory walk, bounded at ~20s; for an exchange-scale account it " +
            "may return coverage:\"partial\" / complete:false. Pass &issuer= (and &type= unless it's " +
            "XRPLHub's issuer) for a direct ledger lookup that is always fast and always complete.",
          security: [],
          tags: ["Credentials"],
          parameters: [
            {
              name: "address", in: "query", required: true,
              description: "XRPL classic address to look up (r...).",
              schema: { type: "string", pattern: "^r[1-9A-HJ-NP-Za-km-z]{24,34}$" },
              example: "rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B",
            },
            {
              name: "issuer", in: "query", required: false,
              description:
                "Restrict to one issuer via direct ledger_entry lookups (no owner-directory walk). " +
                "For XRPLHub's own issuer all four score tiers are probed automatically; for any " +
                "other issuer also pass &type=.",
              schema: { type: "string", pattern: "^r[1-9A-HJ-NP-Za-km-z]{24,34}$" },
              example: "rmWjCGeLtuLGerEuvHDkrsr46ej2Ni13f",
            },
            {
              name: "type", in: "query", required: false,
              description: "Credential type (plain name or hex) — required with &issuer= unless the issuer is XRPLHub's.",
              schema: { type: "string" },
              example: "io.xrplhub.score.v1.min750",
            },
          ],
          responses: {
            "200": ok(
              "Every credential held by this address.",
              {
                type: "object",
                properties: {
                  address: { type: "string" },
                  source: { type: "string", enum: ["live"] },
                  lookup: { type: "string", enum: ["owner-walk", "targeted"] },
                  coverage: { type: "string", enum: ["complete", "partial"] },
                  complete: { type: "boolean" },
                  warning: { type: "string", nullable: true },
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
                lookup: "targeted",
                coverage: "complete",
                complete: true,
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

      "/api/mpt/{issuanceId}": {
        get: {
          operationId: "mptRisk",
          summary: "MPT issuance risk view — issuer powers + issuer trust (free, live)",
          description:
            "The risk view of one Multi-Purpose Token (XLS-33) issuance, not a listing. Returns what the " +
            "issuer can do to a holder (clawback, freeze, require-auth, whether it's transferable at all) " +
            "alongside the issuer's own XRPLScore, account age, verified domain and credentials held. Live " +
            "reads from the validated ledger, cross-checked against Bithomp's index. An issuance not found " +
            "returns \"unknown\", never \"does not exist\". Free, no signup.",
          security: [],
          tags: ["Tokens"],
          parameters: [{
            name: "issuanceId", in: "path", required: true,
            description: "The MPTokenIssuanceID — 48 hexadecimal characters (XLS-33, 192-bit: creating-tx Sequence + issuer AccountID).",
            schema: { type: "string", pattern: "^[0-9A-Fa-f]{48}$" },
            example: "0641C7D1F9C6BB3B75EA31B353A54E2EFAC423498EF25045",
          }],
          responses: {
            "200": ok(
              "The issuance risk view.",
              {
                type: "object",
                properties: {
                  issuanceId: { type: "string" },
                  found: { type: "boolean" },
                  source: {
                    type: "object",
                    properties: {
                      ledger: { type: "string" },
                      bithompIndex: { type: "string" },
                      interpretation: { type: "string", description: "'exists', 'may have been destroyed', or 'unknown'." },
                    },
                  },
                  issuer: { type: "string", nullable: true },
                  issuance: {
                    type: "object", nullable: true,
                    properties: {
                      assetScale: { type: "integer" },
                      maximumAmount: { type: "string", nullable: true },
                      outstandingAmount: { type: "string" },
                      transferFeeBps: { type: "number" },
                      metadata: {},
                    },
                  },
                  issuerPowers: {
                    type: "object", nullable: true,
                    properties: {
                      clawback: { type: "boolean" },
                      canFreeze: { type: "boolean" },
                      currentlyFrozen: { type: "boolean" },
                      requiresAuth: { type: "boolean" },
                      transferable: { type: "boolean" },
                    },
                  },
                  issuerRisk: {
                    type: "object", nullable: true,
                    properties: {
                      xrplScore: { type: "integer", nullable: true },
                      grade: { type: "string", nullable: true },
                      accountAgeDays: { type: "integer", nullable: true },
                      blackholed: { type: "boolean" },
                      domain: { type: "string", nullable: true },
                      domainVerified: { type: "boolean", description: "Issuer address is listed in the domain's xrp-ledger.toml." },
                      credentialsHeld: { type: "integer" },
                      credentials: { type: "array", items: { type: "object" } },
                    },
                  },
                },
              },
              {
                issuanceId: "0641C7D1F9C6BB3B75EA31B353A54E2EFAC423498EF25045",
                found: true,
                source: {
                  ledger: "MPTokenIssuance present on the validated ledger (live read)",
                  bithompIndex: "listed in Bithomp's index",
                  interpretation: "exists",
                },
                issuer: "rPm6K1fr4MNcv5W8pD4RCawVHjsK1ziCKp",
                issuance: { assetScale: 0, maximumAmount: "1", outstandingAmount: "0", transferFeeBps: 0, metadata: { t: "SCPO", ac: "rwa" } },
                issuerPowers: { clawback: true, canFreeze: false, currentlyFrozen: false, requiresAuth: false, transferable: false },
                issuerRisk: {
                  xrplScore: 475, grade: "Building", accountAgeDays: 80, blackholed: false,
                  domain: "ipfs://Qm…", domainVerified: false, credentialsHeld: 2, credentials: [],
                },
              }
            ),
            "400": { description: "issuanceId is not 48 hex characters." },
          },
        },
      },

      "/api/mpt/search": {
        get: {
          operationId: "mptSearch",
          summary: "Search the MPT registry index (free)",
          description:
            "Find Multi-Purpose Token (XLS-33) issuances by issuer address, MPTokenIssuanceID (or a hex " +
            "prefix), or token name / ticker. Served from the registry index — the union of Bithomp's " +
            "per-issuer data and our own ledger_data walk. The response carries `coverage` " +
            "(\"complete-per-known-issuer\" | \"partial\") with `guarantees` / `doesNotGuarantee` strings: " +
            "\"complete-per-known-issuer\" means every issuance of every issuer we know about is indexed and " +
            "ledger-verified, NOT that no unknown issuer exists. Free, no signup.",
          security: [],
          tags: ["Tokens"],
          parameters: [{
            name: "q", in: "query", required: true,
            description: "Issuer address (r...), MPTokenIssuanceID or hex prefix, or a token name / ticker.",
            schema: { type: "string", minLength: 2 },
            example: "rM7ffj9GZV41K8fWUhtpfZSZvYoZB2yA4t",
          }],
          responses: {
            "200": ok(
              "Matching issuances from the index.",
              {
                type: "object",
                properties: {
                  query: { type: "string" },
                  matchedBy: { type: "string", enum: ["issuer", "issuanceId", "name"] },
                  source: { type: "string", enum: ["indexed"] },
                  coverage: { type: "string", enum: ["complete-per-known-issuer", "partial"] },
                  knownIssuers: { type: "integer" },
                  indexedIssuances: { type: "integer" },
                  cappedIssuers: { type: "integer", description: "known issuers with >100 issuances Bithomp free can't fully page" },
                  freshnessFloorAt: { type: "string", format: "date-time", nullable: true },
                  lastCompletedStateWalkPassAt: { type: "string", format: "date-time", nullable: true },
                  guarantees: { type: "string" },
                  doesNotGuarantee: { type: "string" },
                  count: { type: "integer" },
                  truncated: { type: "boolean" },
                  results: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        issuanceId: { type: "string" },
                        issuer: { type: "string" },
                        name: { type: "string", nullable: true },
                        assetScale: { type: "integer" },
                        maximumAmount: { type: "string", nullable: true },
                        outstandingAmount: { type: "string" },
                        transferFeeBps: { type: "number" },
                        holderCount: { type: "integer", nullable: true },
                        issuerPowers: { type: "object" },
                        sources: { type: "array", items: { type: "string", enum: ["walk", "bithomp"] } },
                        lastSeenAt: { type: "string", format: "date-time" },
                      },
                    },
                  },
                  related: { type: "array", items: { type: "object" } },
                },
              },
              {
                query: "rM7ffj9GZV41K8fWUhtpfZSZvYoZB2yA4t",
                matchedBy: "issuer",
                source: "indexed",
                coverage: "complete-per-known-issuer",
                knownIssuers: 34,
                indexedIssuances: 251,
                cappedIssuers: 0,
                freshnessFloorAt: "2026-09-05T18:00:00.000Z",
                lastCompletedStateWalkPassAt: null,
                guarantees: "Every MPTokenIssuance of all 34 issuers we know about is in this index…",
                doesNotGuarantee: "That no MPT issuer exists outside this set…",
                count: 10,
                truncated: false,
                results: [{
                  issuanceId: "0601A5ECE082DA1CE432D2435B0D719CD87FF7EB9B77FDE7",
                  issuer: "rM7ffj9GZV41K8fWUhtpfZSZvYoZB2yA4t",
                  name: "SIV134", assetScale: 0, maximumAmount: "10000000", outstandingAmount: "0",
                  transferFeeBps: 0, holderCount: 0,
                  issuerPowers: { clawback: false, canFreeze: false, currentlyFrozen: false, requiresAuth: false, canEscrow: false, canTrade: true, transferable: true },
                  sources: ["bithomp"], lastSeenAt: "2026-09-05T11:00:00.000Z",
                }],
                related: [],
              }
            ),
            "400": { description: "q missing or shorter than 2 characters." },
          },
        },
      },

      "/api/mpt/issuer": {
        get: {
          operationId: "mptIssuer",
          summary: "Every MPT an issuer has out, plus their XRPLScore (free)",
          description:
            "Everything one issuer has issued as Multi-Purpose Tokens (XLS-33), from the registry index, " +
            "with each issuance's issuer-power flags, alongside the issuer's own XRPLScore (cached, kept " +
            "fresh by the daily refresh; computed live if not yet cached). Carries `coverage` " +
            "(\"complete-per-known-issuer\" | \"partial\") with `guarantees` / `doesNotGuarantee`. Free, no signup.",
          security: [],
          tags: ["Tokens"],
          parameters: [{
            name: "address", in: "query", required: true,
            description: "XRPL issuer address (r...).",
            schema: { type: "string", pattern: "^r[1-9A-HJ-NP-Za-km-z]{24,34}$" },
            example: "rM7ffj9GZV41K8fWUhtpfZSZvYoZB2yA4t",
          }],
          responses: {
            "200": ok(
              "The issuer's MPTs and score.",
              {
                type: "object",
                properties: {
                  issuer: { type: "string" },
                  source: { type: "string", enum: ["indexed"] },
                  coverage: { type: "string", enum: ["complete-per-known-issuer", "partial"] },
                  knownIssuers: { type: "integer" },
                  indexedIssuances: { type: "integer" },
                  cappedIssuers: { type: "integer" },
                  freshnessFloorAt: { type: "string", format: "date-time", nullable: true },
                  lastCompletedStateWalkPassAt: { type: "string", format: "date-time", nullable: true },
                  guarantees: { type: "string" },
                  doesNotGuarantee: { type: "string" },
                  issuer_known_to_index: { type: "boolean" },
                  aggregateStale: { type: "boolean" },
                  xrplScore: { type: "integer", nullable: true },
                  grade: { type: "string", nullable: true },
                  scoreSource: { type: "string", enum: ["cached", "live", "unavailable"] },
                  scoredAt: { type: "string", format: "date-time", nullable: true },
                  mptCount: { type: "integer" },
                  mpts: { type: "array", items: { type: "object" } },
                  related: { type: "array", items: { type: "object" } },
                },
              },
              {
                issuer: "rM7ffj9GZV41K8fWUhtpfZSZvYoZB2yA4t",
                source: "indexed", coverage: "complete-per-known-issuer",
                knownIssuers: 34, indexedIssuances: 251, cappedIssuers: 0,
                freshnessFloorAt: "2026-09-05T18:00:00.000Z", lastCompletedStateWalkPassAt: null,
                guarantees: "…", doesNotGuarantee: "…",
                issuer_known_to_index: true, aggregateStale: false,
                xrplScore: 597, grade: "Fair", scoreSource: "cached", scoredAt: "2026-09-05T07:00:00.000Z",
                mptCount: 10, mpts: [], related: [],
              }
            ),
            "400": { description: "Missing or invalid address." },
          },
        },
      },

      "/api/mpt/anchor": {
        get: {
          operationId: "mptAnchor",
          summary: "Latest on-ledger anchor of the MPT registry (free)",
          description:
            "The BIS Working Paper 1374 pattern: after each cron pass the registry index is canonicalised, a " +
            "Merkle root is computed over the issuance records, and that root is committed in a Memo on an " +
            "AccountSet transaction from the issuer wallet " +
            "(rmWjCGeLtuLGerEuvHDkrsr46ej2Ni13f). Returns the latest root, its tx hash, ledger index, " +
            "issuance/issuer counts, coverage label, and the exact canonicalisation + Merkle scheme so a " +
            "third party can reproduce the root from /api/mpt/search + /api/mpt/issuer and confirm the " +
            "registry has not been altered. Free, no signup.",
          security: [],
          tags: ["Tokens"],
          responses: {
            "200": ok(
              "The latest anchor plus the verification recipe.",
              {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["ok", "misconfigured", "failing", "pending", "disabled"], description: "Headline — a failed/misconfigured attempt never reads as 'nothing happened'." },
                  message: { type: "string" },
                  health: {
                    type: "object",
                    properties: {
                      anchoringEnabled: { type: "boolean" },
                      signingKeyPresent: { type: "boolean" },
                      misconfigured: { type: "boolean", description: "anchoringEnabled && !signingKeyPresent — fails every run until fixed" },
                      lastAttempt: { type: "object", nullable: true, description: "most recent MptAnchor row, any status" },
                      lastFailure: { type: "object", nullable: true, description: "most recent failed/misconfigured attempt" },
                    },
                  },
                  anchoringEnabled: { type: "boolean" },
                  latest: {
                    type: "object", nullable: true,
                    properties: {
                      canonVersion: { type: "string" },
                      merkleRoot: { type: "string", description: "64-hex lowercase SHA-256 Merkle root" },
                      issuanceCount: { type: "integer" },
                      issuerCount: { type: "integer" },
                      coverage: { type: "string", enum: ["complete-per-known-issuer", "partial"] },
                      freshnessFloorAt: { type: "string", format: "date-time", nullable: true },
                      status: { type: "string", enum: ["pending", "anchored", "failed"] },
                      txHash: { type: "string", nullable: true },
                      ledgerIndex: { type: "integer", nullable: true },
                      account: { type: "string", nullable: true },
                      feeDrops: { type: "string", nullable: true },
                      memo: { type: "string", description: "exact UTF-8 payload; on-ledger MemoData is this hex-encoded" },
                      anchoredAt: { type: "string", format: "date-time", nullable: true },
                      explorer: { type: "string", nullable: true },
                    },
                  },
                  pendingNext: { type: "object", nullable: true, description: "the next snapshot awaiting an anchor, if its root differs from `latest`" },
                  history: {
                    type: "object",
                    properties: { totalSnapshots: { type: "integer" }, anchoredOnLedger: { type: "integer" } },
                  },
                  verify: {
                    type: "object",
                    description: "Everything needed to reproduce merkleRoot: the registry source endpoints, the frozen canonicalisation spec, and where the root sits on-ledger.",
                  },
                },
              },
              {
                anchoringEnabled: false,
                latest: null,
                pendingNext: {
                  canonVersion: "mpt-anchor-v1", merkleRoot: "10cbd62f0b95f16c46ddc9534cae3d549cf91b763254fb75cfbfac7f162c0fab",
                  issuanceCount: 251, issuerCount: 34, coverage: "complete-per-known-issuer",
                  status: "pending", txHash: null, memo: "{\"root\":\"10cbd6…\",\"issuances\":251,\"issuers\":34,\"coverage\":\"complete-per-known-issuer\",\"freshnessFloor\":\"2026-09-05T…\",\"ts\":\"2026-09-05T…\"}",
                },
                history: { totalSnapshots: 1, anchoredOnLedger: 0 },
                verify: { summary: "Recompute the Merkle root from the published rows and check it equals latest.merkleRoot…" },
              }
            ),
          },
        },
      },

      "/api/x402/usdc/mpt/{issuanceId}": {
        get: {
          operationId: "mptRiskFull",
          summary: "MPT issuance risk — full issuer detail (x402, $0.01 USDC on Base)",
          description:
            "Everything /api/mpt/{issuanceId} returns plus the parts that cost real live work: issuer " +
            "account age, blackhole check, xrp-ledger.toml domain verification, the full credential list, " +
            "the Bithomp cross-check, and a `related` cross-sell block. x402 exact scheme, USDC on Base " +
            "via the CDP facilitator. No signup.",
          tags: ["Tokens"],
          parameters: [{
            name: "issuanceId", in: "path", required: true,
            description: "The MPTokenIssuanceID — 48 hexadecimal characters.",
            schema: { type: "string", pattern: "^[0-9A-Fa-f]{48}$" },
            example: "0641C7D1F9C6BB3B75EA31B353A54E2EFAC423498EF25045",
          }],
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: "0.010000" },
            protocols: [{ x402: {} }],
            description: "Full MPT issuer risk view, USDC on Base via the CDP x402 facilitator.",
          },
          responses: {
            "200": { description: "Full risk view — see /api/mpt/{issuanceId} 200 schema plus issuerRisk.{accountAgeDays,blackholed,domain,domainVerified,credentials} and a related[] block." },
            "402": { description: "Payment Required — x402 challenge. Pay in USDC on Base and retry with the X-PAYMENT header." },
          },
        },
      },

      "/api/screen/ofac": {
        get: {
          operationId: "screenOfac",
          summary: "OFAC SDN screening attestation (API key — free tier included)",
          description:
            "Compare one XRPL address against a vintage-pinned OFAC SDN snapshot (exact address-string " +
            "match only) and get a factual, Merkle-anchored receipt: which list, its published version, the " +
            "file SHA-256, and whether the address appeared on it. A 'no match' means the address was not on " +
            "that list version — NOT that it is clean or unsanctioned. This attests to PROCESS, not ground " +
            "truth: it does not say any address or person is sanctioned or risky, gives no legal or " +
            "compliance advice, and does not discharge your own screening obligations. Every receipt (match " +
            "or no-match) is anchored on-ledger daily; verify at GET /api/attest/verify?queryId=. " +
            "Auth: Authorization: Bearer <API key> (a free key works). Terms: /legal/screening.",
          tags: ["Screening"],
          parameters: [screenAddrParam],
          responses: {
            "200": ok("The screening receipt.", screenOutputSchema, screenOutputExample),
            "401": { description: "Missing or invalid API key." },
            "402": { description: "API key term ended (error \"key_expired\") — buy a new key." },
            "503": { description: "No OFAC SDN snapshot ingested yet." },
          },
        },
      },

      "/api/x402/screen/ofac": {
        get: {
          operationId: "x402ScreenOfac",
          summary: "OFAC SDN screening attestation (x402, $0.01 USDC on Base)",
          description:
            "The same OFAC SDN screening attestation as /api/screen/ofac, priced for agents at $0.01 per " +
            "call and settled in USDC on Base via the CDP x402 facilitator — no API key, no signup. " +
            "Compares one XRPL address against a vintage-pinned SDN snapshot (exact match only) and returns " +
            "a Merkle-anchored receipt. A 'no match' is not a statement that the address is clean or " +
            "unsanctioned. Attests to process, not ground truth. Not legal/compliance advice; does not " +
            "discharge your screening obligations. Verify at GET /api/attest/verify?queryId=.",
          tags: ["Screening"],
          parameters: [screenAddrParam],
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: "0.010000" },
            protocols: [{ x402: {} }],
            description: "One OFAC SDN screening attestation, USDC on Base via the CDP x402 facilitator.",
          },
          responses: {
            "200": ok("The screening receipt.", screenOutputSchema, screenOutputExample),
            "402": { description: "Payment Required — x402 challenge. Pay in USDC on Base and retry with the X-PAYMENT header." },
          },
        },
      },

      "/api/attest/verify": {
        get: {
          operationId: "attestVerify",
          summary: "Verify a screening attestation receipt (free)",
          description:
            "Given a screening receipt's queryId, returns the canonical leaf, its Merkle inclusion proof, " +
            "the on-ledger anchor transaction and ledger close time, and the list snapshot hash — " +
            "everything needed to verify the receipt WITHOUT trusting XRPLHub. Rebuild the leaf, fold the " +
            "proof to the Merkle root, confirm that root is in the anchor tx's MemoData, and re-hash the " +
            "cited OFAC SDN publication. Add &include=snapshot to fetch the full canonical list archive " +
            "that was screened against. Free, no signup.",
          security: [],
          tags: ["Screening"],
          parameters: [
            {
              name: "queryId", in: "query", required: true,
              description: "The receipt's queryId (UUID), returned by /api/screen/ofac.",
              schema: { type: "string", format: "uuid" },
            },
            {
              name: "include", in: "query", required: false,
              description: "Pass 'snapshot' to return the full canonical OFAC SDN list archive instead of the receipt.",
              schema: { type: "string", enum: ["snapshot"] },
            },
          ],
          responses: {
            "200": { description: "The receipt, its inclusion proof, the anchor tx, and the list snapshot hash." },
            "404": { description: "No receipt with that queryId." },
          },
        },
      },

      "/api/lending/exposure": {
        get: {
          operationId: "lendingExposure",
          summary: "XLS-66 cross-broker lending exposure — aggregate (API key, free tier)",
          description:
            "A borrower's total XLS-66 lending exposure across ALL loan brokers in one call: total outstanding " +
            "by asset, loan count, distinct broker count, defaults/impairments, XRPLScore, and an observation " +
            "summary. The XRP Ledger has no aggregate borrower-debt object. It reflects the validated ledger " +
            "NOW — a defaulted loan zeroes its own amounts and either party can delete a paid/defaulted loan, " +
            "so absence is not proof of no borrowing history. `disposition` distinguishes 'no-loans-ever' " +
            "(we have never observed one — not proof of none) from 'history-only' (loans seen before, none " +
            "now). EVERY call persists an immutable, Merkle-anchored snapshot — verify at " +
            "/api/attest/verify?queryId=. Pre-activation returns 503 with the live XRPLScore; serves " +
            "automatically when the LendingProtocol amendment enables. Not underwriting or credit advice. " +
            "Full per-loan detail + per-broker first-loss context: /api/x402/lending/exposure ($0.01 USDC).",
          tags: ["Lending"],
          parameters: [borrowerParam],
          responses: {
            "200": ok("Aggregate exposure + observation summary.", exposureOutputSchema, {}),
            "401": { description: "Missing or invalid API key." },
            "503": { description: "LendingProtocol (XLS-66) not yet enabled on mainnet — body carries the XRPLScore." },
          },
        },
      },

      "/api/lending/history": {
        get: {
          operationId: "lendingHistory",
          summary: "Every loan XRPLHub has ever observed for a borrower (API key, free tier)",
          description:
            "The credit file XLS-66 can't keep. Built from append-only exposure snapshots: every loan ever " +
            "observed for this borrower with first/last observed ledger, last-known status, monotonic " +
            "everDefaulted / everImpaired / everOverdue flags, and — for loans since deleted from the ledger " +
            "— the ledger window in which they vanished. A borrower who defaulted and deleted the loan shows " +
            "nothing on-ledger; here it shows as vanished with everDefaulted true. `observationWindow` states " +
            "how far back our view goes — loans deleted before firstObservedAt are invisible to us. A daily cron " +
            "sweep re-observes every known borrower so the history has no gaps where nobody queried; the " +
            "sweepCoverage block reports when this borrower was last swept and lists any observation gaps. Free.",
          tags: ["Lending"],
          parameters: [borrowerParam],
          responses: {
            "200": { description: "Per-loan observation records + summary + observation window." },
            "401": { description: "Missing or invalid API key." },
          },
        },
      },

      "/api/x402/lending/exposure": {
        get: {
          operationId: "x402LendingExposure",
          summary: "XLS-66 cross-broker lending exposure — full detail (x402, $0.01 USDC on Base)",
          description:
            "Everything /api/lending/exposure returns PLUS every loan decoded (rates in bps, days-to-due / " +
            "days-overdue, flags), the per-broker first-loss context (the counterparty broker's own " +
            "DebtTotal / CoverAvailable / CoverRateMinimum), the last-known state of every vanished loan, and " +
            "the Merkle-anchored attestation receipt. $0.01 USDC on Base via the CDP x402 facilitator, no " +
            "signup. Amendment-gated: 503 until XLS-66 enables, then serves automatically. Attests to " +
            "OBSERVED STATE, not a complete borrowing history. Not underwriting or credit advice.",
          tags: ["Lending"],
          parameters: [borrowerParam],
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: "0.010000" },
            protocols: [{ x402: {} }],
            description: "Full cross-broker lending exposure for one borrower, USDC on Base via the CDP x402 facilitator.",
          },
          responses: {
            "200": ok("Full exposure — loans[], brokers[], vanishedLoans[], attestation.", exposureOutputSchema, {}),
            "402": { description: "Payment Required — x402 challenge. Pay in USDC on Base and retry with the X-PAYMENT header." },
            "503": { description: "LendingProtocol (XLS-66) not yet enabled on mainnet." },
          },
        },
      },

      "/api/x402/lending/underwrite": {
        get: {
          operationId: "x402LendingUnderwrite",
          summary: "XLS-66 underwriting inputs — full bundle (x402, $0.05 USDC on Base)",
          description:
            "Every input a LoanBroker needs for an XLS-66 underwriting decision in one call: cross-broker " +
            "exposure (outstanding by asset, defaults, impairments), XRPLScore + grade, OFAC SDN screening " +
            "with its own verifiable receipt, observation history + gaps, and one Merkle-anchored attestation " +
            "over the whole bundle. FACTS ONLY — the response has no field for a recommended principal, rate, " +
            "rate floor, approve/decline, probability of default, risk score, or eligibility, and never will. " +
            "The lending decision, and responsibility for it, is entirely the broker's. Not lending or " +
            "underwriting advice. x402 only — no free tier, no API-key path. Amendment-gated: 503 (carrying " +
            "the live XRPLScore + OFAC result) until the LendingProtocol amendment enables on mainnet.",
          tags: ["Lending"],
          parameters: [borrowerParam],
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: "0.050000" },
            protocols: [{ x402: {} }],
            description: "The full underwriting-inputs bundle for one borrower, USDC on Base via the CDP x402 facilitator.",
          },
          responses: {
            "200": { description: "The bundle: exposure, score, screening (+ receipt), observation history, one attestation." },
            "402": { description: "Payment Required — x402 challenge. Pay in USDC on Base and retry with the X-PAYMENT header." },
            "503": { description: "LendingProtocol (XLS-66) not yet enabled — body carries the live XRPLScore + OFAC screening." },
          },
        },
      },

      "/api/execute/preview": {
        post: {
          operationId: "executePreview",
          summary: "Free preview of a service transaction (no payment)",
          description:
            "Builds the exact service transaction and returns it DECODED, unsigned, with nothing submitted. " +
            "For the MPT issuance builder (productId 'mptissue') it also returns the full manifest of what is " +
            "PERMANENT once signed, a plain-English guide to all 6 capability flags (what each lets the issuer " +
            "do to holders — clawback means you can take the token back from anyone), and the issuer's backing " +
            "declaration echoed back with the hard line: XRPLHub publishes the declaration and does not verify " +
            "it. Pay via /api/create-payment then /api/execute to actually build and sign. Free.",
          security: [],
          tags: ["Transactions"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["productId", "account"],
                  properties: {
                    productId: { type: "string", example: "mptissue" },
                    account: { type: "string", pattern: "^r[1-9A-HJ-NP-Za-km-z]{24,34}$", description: "the issuer / signer" },
                    params: { type: "object", description: "per-service params — see /api/mcp list_xrpl_services" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "The decoded txjson + (for mptissue) the permanence manifest, flag guide, and backing declaration." },
            "400": { description: "Bad request / invalid params." },
            "422": { description: "Missing required params (see needsParams)." },
          },
        },
      },

      "/api/x402/usdc/score": {
        post: {
          operationId: "x402UsdcScore",
          summary: "XRPLScore — per-call, agent-priced (x402, $0.01 USDC on Base)",
          description:
            "The same 300–850 score and 8-signal breakdown as /api/x402/score, priced for agents at " +
            "$0.01 per call and settled in USDC on Base via the CDP x402 facilitator (not the RLUSD/t54 " +
            "rail). POST a JSON body {\"wallet\":\"r...\"}. No signup.",
          tags: ["Scoring"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["wallet"],
                  properties: { wallet: { type: "string", pattern: "^r[1-9A-HJ-NP-Za-km-z]{24,34}$" } },
                },
                example: { wallet: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De" },
              },
            },
          },
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: "0.010000" },
            protocols: [{ x402: {} }],
            description: "Per-call wallet score, USDC on Base via the CDP x402 facilitator.",
          },
          responses: {
            "200": ok("Wallet score with the 8 signals, grade and percentile.", scoreSchema, scoreExample),
            "402": { description: "Payment Required — x402 challenge. Pay in USDC on Base and retry with the X-PAYMENT header." },
          },
        },
      },
    },
  };

  return NextResponse.json(doc, { headers: { "Cache-Control": "public, max-age=300" } });
}

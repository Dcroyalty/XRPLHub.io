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
} from "@/lib/paycall";

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
        "A 300–850 wallet creditworthiness score from 8 signals, full risk reports, an agent payment pre-check, MPT issuer " +
        "risk, sanctions screening and XLS-66 lending data. No account, no API key, no signup. " +
        "A free (unauthenticated) score is also at GET /api/score/{wallet}. UNSIGNED ONLY: XRPLHub builds transactions and " +
        "scores wallets but never signs or holds keys; the caller signs with their own wallet. XRPLHub does not build generic " +
        "XRPL transactions (that catalog was removed on 2026-10-07).\n\n" +
        "AGENT SAFETY on every paid x402 route, on both rails (RLUSD on XRPL or USDC on Base, same price): the payment settles ONLY after the paid " +
        "work returns success — a handler failure returns `error: \"handler_failed\"` and does NOT charge " +
        "you (retry with the same PAYMENT-SIGNATURE within maxTimeoutSeconds). Send an `Idempotency-Key` " +
        "header (or rely on the payment invoiceId) — a retried request replays the original response, so " +
        "you can never pay twice. Every failure `error` is one of the codes in /.well-known/x402 " +
        "`errorCodes`.\n\n" +
        "RETIRED (HTTP 410): /api/tx, /api/x402/tx and /api/x402-tx (the generic transaction catalog); " +
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
            "x402 exact scheme on either rail at the same $0.02: RLUSD on the XRP Ledger (t54, PAYMENT-SIGNATURE) or USDC on Base " +
            "(CDP, X-PAYMENT). Send ?wallet=<r-address>. No signup.",
          tags: ["Scoring"],
          parameters: [walletParam()],
          "x-payment-info": payment(PRICE_PER_SCORE_RLUSD, "Single wallet score — RLUSD on XRPL or USDC on Base, same price."),
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
            "count, DEX/AMM/NFT activity). $0.08 on either rail: RLUSD on XRPL (t54) or USDC on Base (CDP). Send ?wallet=<r-address>. No signup.",
          tags: ["Scoring"],
          parameters: [walletParam()],
          "x-payment-info": payment(PRICE_PER_PRODUCT_RLUSD, "Full risk report for one wallet — RLUSD on XRPL or USDC on Base, same price."),
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
            "reads from the validated ledger only. An issuance not found " +
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
                      interpretation: { type: "string", description: "'exists' or 'unknown'." },
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
                      domainVerified: { type: "boolean", description: "Two-way check: the account's own Domain field, AND that domain's xrp-ledger.toml lists this exact account under [[ACCOUNTS]]." },
                        domainVerifiedReason: { type: "string", description: "why (or why not) verified — which direction failed, HTTP status, or the confirming toml URL." },
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
                  interpretation: "exists",
                },
                issuer: "rPm6K1fr4MNcv5W8pD4RCawVHjsK1ziCKp",
                issuance: { assetScale: 0, maximumAmount: "1", outstandingAmount: "0", transferFeeBps: 0, metadata: { t: "SCPO", ac: "rwa" } },
                issuerPowers: { clawback: true, canFreeze: false, currentlyFrozen: false, requiresAuth: false, transferable: false },
                issuerRisk: {
                  xrplScore: 475, grade: "Building", accountAgeDays: 80, blackholed: false,
                  domain: "ipfs://Qm…", domainVerified: false, domainVerifiedReason: "the account's Domain field does not decode to a plausible hostname", credentialsHeld: 2, credentials: [],
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
                guarantees: "Every MPTokenIssuance of all <knownIssuers> issuers we know about is in this index, pulled from Bithomp's per-issuer feed. Oldest per-issuer refresh: <freshnessFloorAt>. (Live values are computed per request — this example is illustrative.)",
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
            "AccountSet transaction from a dedicated anchor wallet " +
            "(r9dQS1oGms3B7SdY6nyU24Dy7dWyWXuJXb — NOT the credential issuer). Returns the latest root, its tx hash, ledger index, " +
            "issuance/issuer counts, coverage label, and the exact canonicalisation + Merkle scheme so a " +
            "third party can reproduce the root from /api/mpt/search + /api/mpt/issuer and check that the " +
            "registry rows we publish match the root we anchored on-ledger at a known time. (The index is " +
            "mutable and can be re-anchored; this proves published-rows-match-anchored-root, not immutability.) " +
            "Free, no signup.",
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
          summary: "MPT issuance risk — full issuer detail (x402, $0.01 USDC on Base or RLUSD on XRPL)",
          description:
            "Everything /api/mpt/{issuanceId} returns plus the parts that cost real live work: issuer " +
            "account age, blackhole check, xrp-ledger.toml domain verification, the full credential list, " +
            "and a `related` cross-sell block (all live ledger reads). x402 exact scheme, USDC on Base " +
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
            "402": { description: "Payment Required — x402 challenge. Pay EITHER in USDC on Base (v1 body; retry with X-PAYMENT) OR in RLUSD on the XRP Ledger (v2: PAYMENT-REQUIRED header, network xrpl:0; retry with PAYMENT-SIGNATURE, result wrapped as { data, x402 })." },
          },
        },
      },

      "/api/x402/precheck": {
        get: {
          operationId: "paymentPrecheck",
          summary: "Agent payment pre-check — one verdict before paying an XRPL address (x402, $0.03 USDC on Base or RLUSD on XRPL)",
          description:
            "Before an agent pays an XRPL address: a verdict (block / caution / proceed) by fixed published rules, with the " +
            "destination's XRPLScore, a sanctions screen against every list held (anchored receipt, verify at /api/attest/verify), " +
            "account age and ledger flags, and wouldFail when the ledger would reject the payment as described (missing " +
            "destination tag, Deposit Authorization, no RLUSD trust line, unfunded account). The rules are returned in every " +
            "response. Not advice; 'proceed' only means no rule fired. No signup.",
          tags: ["Agents"],
          parameters: [
            { name: "destination", in: "query", required: true, description: "The XRPL address you are about to pay.", schema: { type: "string" } },
            { name: "amount", in: "query", required: false, description: "Amount you intend to send.", schema: { type: "string" } },
            { name: "currency", in: "query", required: false, schema: { type: "string", enum: ["XRP", "RLUSD"] } },
            { name: "destinationTag", in: "query", required: false, schema: { type: "integer" } },
            { name: "from", in: "query", required: false, description: "Your paying address (checks Deposit Authorization preauth).", schema: { type: "string" } },
          ],
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: "0.030000" },
            protocols: [{ x402: {} }],
            description: "Agent payment pre-check, USDC on Base (CDP) or RLUSD on XRPL (t54).",
          },
          responses: {
            "200": { description: "{ verdict, wouldFail, reasons[], xrplScore, sanctions, account, payment, rules[], disclaimer }" },
            "400": { description: "Malformed destination / amount / tag — refused before any charge." },
            "402": { description: "Payment Required — x402 challenge on either rail (see /api/x402/usdc/mpt/{issuanceId})." },
          },
        },
      },

      "/api/x402/permissions": {
        get: {
          operationId: "walletPermissions",
          summary: "Wallet permissions check — who can move money out of an XRPL wallet (x402, $0.02 USDC on Base or RLUSD on XRPL)",
          description:
            "Read live from the ledger: signing power (master key on/off, regular key, multi-sign signer list, blackholed), " +
            "permission delegations given and received (PermissionDelegation, live on mainnet since 2026-10-08), and money " +
            "others can pull without a new approval (checks the wallet wrote, payment channels it funds, escrows it created, " +
            "open DEX offers, NFT sell offers, tickets). Each finding has a level (danger | warning | info | ok), the account " +
            "holding the power, a plain-English sentence, the raw ledger facts and, where one exists, a free fix " +
            "(revoke_delegation, cancel_check). People: free page at /permissions. No signup.",
          tags: ["Agents"],
          parameters: [{ name: "address", in: "query", required: true, description: "The XRPL account (r...) to check.", schema: { type: "string" } }],
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: "0.020000" },
            protocols: [{ x402: {} }],
            description: "Wallet permissions check, USDC on Base (CDP) or RLUSD on XRPL (t54).",
          },
          responses: {
            "200": { description: "{ address, exists, ledgerIndex, headline, canMoveMoney[{who,how}], findings[{kind,level,who,plain,detail,fix?}], truncated, notes[] }" },
            "400": { description: "Malformed address — refused before any charge." },
            "402": { description: "Payment Required — x402 challenge on either rail (see /api/x402/usdc/mpt/{issuanceId})." },
          },
        },
      },

      "/api/permissions/fix": {
        post: {
          operationId: "walletPermissionsFix",
          summary: "Free fix for a permissions finding: revoke a delegation or cancel a check (unsigned transaction + Xaman request)",
          description:
            "Body { action: \"revoke_delegation\", account, delegate } returns a DelegateSet with an empty Permissions list; " +
            "{ action: \"cancel_check\", account, checkId } returns a CheckCancel. The finding is re-verified on the live ledger " +
            "first. Free. XRPLHub never signs: the account owner signs in their own wallet.",
          tags: ["Agents"],
          responses: {
            "200": { description: "{ txjson, uuid, qr_png, deep_link, websocket, free: true }" },
            "400": { description: "Bad action or address." },
            "404": { description: "No such delegation or open check on this account." },
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

      "/api/screen": {
        get: {
          operationId: "screenAddress",
          summary: "Sanctions screening attestation — OFAC SDN + EU + UK, XRPL/EVM/Bitcoin/Tron (API key)",
          description:
            "Compare one address against the current snapshot of every sanctions list we hold that names crypto addresses (OFAC-SDN, EU-FSF, UK-SL) by exact address-string match on the address's own chain. " +
            "The receipt names every list, its version and file hash, and how many addresses it names on that chain. Attests to PROCESS, not ground truth: 'no match' is not 'clean'. " +
            "The EU and UK lists are name-based and name few crypto addresses; the UN list is not screened. Not legal advice; using it does not satisfy any obligation. " +
            "Optional reference = your own opaque id (never personal data). Fails closed: 400 for an unsupported address, 503 if any list is not loaded. Retention: at least 10 years, never pruned. POST { address, lists, reference } also works.",
          tags: ["Screening"],
          parameters: [
            { name: "address", in: "query", required: true, description: "XRPL, EVM (0x…), Bitcoin or Tron address.", schema: { type: "string" } },
            { name: "lists", in: "query", required: false, description: "Comma list of OFAC-SDN,EU-FSF,UK-SL (default all).", schema: { type: "string" } },
            { name: "reference", in: "query", required: false, description: "Your opaque reference (<=64 chars).", schema: { type: "string" } },
          ],
          responses: { "200": ok("The screening receipt.", { type: "object" }, {}), "400": { description: "Unsupported or invalid address." }, "401": { description: "Missing or invalid API key." }, "503": { description: "A list is not loaded yet; screening is unavailable rather than partial." } },
        },
      },

      "/api/screen/batch": {
        post: {
          operationId: "screenBatch",
          summary: "Batch sanctions screening — up to 100 addresses, one receipt each (API key)",
          description: "Screen up to 100 addresses (mixed chains) in one call against the same list snapshots. One receipt per address, all stored together so they land in the same on-ledger anchor batch, sharing a batchId. Each valid address counts as one call against your quota; an invalid address is reported per item.",
          tags: ["Screening"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["addresses"], properties: { addresses: { type: "array", maxItems: 100, items: { oneOf: [{ type: "string" }, { type: "object", properties: { address: { type: "string" }, reference: { type: "string" } } }] } }, lists: { type: "string" } } } } } },
          responses: { "200": ok("Per-address results and the batchId.", { type: "object" }, {}), "400": { description: "Bad request or more than 100 addresses." }, "429": { description: "Quota cannot cover the whole batch; nothing was screened." }, "503": { description: "A list is not loaded yet." } },
        },
      },

      "/api/screen/lists": {
        get: {
          operationId: "screeningLists",
          summary: "Which sanctions lists are screened, what each really contains, and the versions in force (free)",
          description: "Per list: publisher, what it really contains (the EU and UK lists are name-based with few addresses), current vintage, content hash, addresses per chain, last confirmed; what is not screened (UN); supported chains; integrity gates; retention; limitations.",
          tags: ["Screening"],
          security: [],
          responses: { "200": ok("List catalogue.", { type: "object" }, {}) },
        },
      },

      "/api/attest/export": {
        get: {
          operationId: "exportScreeningReceipts",
          summary: "Auditor export — every receipt your key produced in a date range, with proofs (API key)",
          description: "Every screening receipt (its own screens and its monitoring subscriptions') in [from, to), oldest first, each with the exact list versions, canonical leaf, leaf hash, Merkle inclusion proof and the anchor transaction hash, as JSON or CSV. Not-yet-anchored receipts are included with status pending. Max 366 days per request; paginate with cursor.",
          tags: ["Screening"],
          parameters: [
            { name: "from", in: "query", required: false, description: "Inclusive; date or ISO time (default: 30 days before to).", schema: { type: "string" } },
            { name: "to", in: "query", required: false, description: "Exclusive; date or ISO time (default now).", schema: { type: "string" } },
            { name: "format", in: "query", required: false, schema: { type: "string", enum: ["json", "csv"] } },
            { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 1000 } },
            { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          ],
          responses: { "200": ok("The export.", { type: "object" }, {}), "400": { description: "Bad range/cursor." }, "401": { description: "Missing or invalid API key." } },
        },
      },

      "/api/domains/build": {
        get: {
          operationId: "buildScoreDomain",
          summary: "Plan a Permissioned Domain gated on XRPLScore credential tiers (free plan; the transaction is the paid 'permdomain' service)",
          description: "Given the domain-owner account and the lowest tier to admit (min600|min650|min700|min750), returns the exact accepted-credential list (the floor tier AND every tier above it — a wallet holds only its highest tier), cost, member steps, and the x402 resource that delivers the unsigned PermissionedDomainSet. Optional alsoAccept and domainId (update). Unsigned only.",
          tags: ["Credentials"],
          security: [],
          parameters: [
            { name: "account", in: "query", required: true, schema: { type: "string" } },
            { name: "minTier", in: "query", required: true, schema: { type: "string", enum: ["min600", "min650", "min700", "min750"] } },
            { name: "alsoAccept", in: "query", required: false, schema: { type: "string" } },
            { name: "domainId", in: "query", required: false, schema: { type: "string" } },
          ],
          responses: { "200": ok("The plan.", { type: "object" }, {}), "400": { description: "Bad request." } },
        },
      },

      "/api/credentials/request": {
        post: {
          operationId: "requestScoreCredential",
          summary: "Request your XRPLScore credential — we issue, you accept",
          description: "Scores the wallet fresh; if it clears 600 a request is queued for its tier (202). A person issues queued credentials from an offline key; the wallet then signs CredentialAccept (GET the same URL with ?subject= for status and the unsigned accept). Below 600: not_eligible, nothing queued.",
          tags: ["Credentials"],
          security: [],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["subject"], properties: { subject: { type: "string" } } } } } },
          responses: { "202": ok("Queued.", { type: "object" }, {}), "200": ok("Already held / not eligible.", { type: "object" }, {}), "429": { description: "Too many requests." } },
        },
        get: {
          operationId: "scoreCredentialRequestStatus",
          summary: "Status of a credential request, with the unsigned CredentialAccept when it is due",
          tags: ["Credentials"],
          security: [],
          parameters: [{ name: "subject", in: "query", required: true, schema: { type: "string" } }],
          responses: { "200": ok("Status.", { type: "object" }, {}) },
        },
      },

      "/api/x402/screen/ofac": {
        get: {
          operationId: "x402ScreenOfac",
          summary: "OFAC SDN screening attestation (x402, $0.01 USDC on Base or RLUSD on XRPL)",
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
            "402": { description: "Payment Required — x402 challenge. Pay EITHER in USDC on Base (v1 body; retry with X-PAYMENT) OR in RLUSD on the XRP Ledger (v2: PAYMENT-REQUIRED header, network xrpl:0; retry with PAYMENT-SIGNATURE, result wrapped as { data, x402 })." },
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

      "/api/monitor": {
        get: {
          operationId: "monitoringInfo",
          summary: "Continuous monitoring: what it does, its limits and its honest capacity (no key)",
          description:
            "Continuous monitoring is layered on top of underwriting, not a replacement. Underwriting judges structural risk before signing; " +
            "monitoring reports OBSERVED behavioral changes in public XRP Ledger data after — once a day, for wallets you choose. Not real-time. " +
            "Returns the event types, per-plan watch slots (free 3, starter 25, growth 250, scale 2,500 — per-key ceilings), the shared platform " +
            "limit (what the one daily monitoring run can keep current) with the free-tier ceiling, the consumer-use acknowledgement text + version, webhook signing rules and the disclaimer.",
          tags: ["Monitoring"],
          responses: { "200": { description: "Capabilities, limits, capacity statement, acknowledgement text." } },
        },
      },
      "/api/monitor/subscribe": {
        post: {
          operationId: "monitorSubscribe",
          summary: "Watch up to 25 wallets and register one webhook (API key; a free key works, 3 wallets)",
          description:
            "Body: { addresses: string[≤25], webhookUrl (https, port 443, public hostname), scoreDropPoints? (1–550; omit = no score_drop events — there is NO default threshold), " +
            "subscriptionId? (add to an existing subscription), acknowledgement: { accepted: true, version } } — the consumer-use acknowledgement (no use for consumer credit/insurance/" +
            "employment/housing decisions under FCRA/ECOA) is REQUIRED and stored with a timestamp. A test ping is sent first; if it is not answered 2xx nothing is created. " +
            "The signing secret (X-XRPLHub-Signature: v1=HMAC-SHA256 over '<timestamp>.<body>') is returned ONCE. Events: score_drop, sanctions_hit, sanctions_delisted, " +
            "first_loan_observed, loan_overdue, loan_impaired, loan_defaulted (the loan events are dormant until XLS-66 activates, then fire automatically) and monitoring_degraded. " +
            "Attested observations are sparse (baseline / change / event / weekly heartbeat) under the frozen monitor-observation-v1 canon; a score is included only when freshly computed.",
          tags: ["Monitoring"],
          responses: {
            "201": { description: "Subscription, one-time webhookSecret, per-wallet baseline status, capabilities, limits." },
            "400": { description: "acknowledgement_required, batch_too_large, bad_webhook_url, webhook_ping_failed, bad_request." },
            "401": { description: "Missing or invalid API key." },
            "403": { description: "watch_slots_exceeded." },
            "503": { description: "monitoring_capacity_reached (shared platform limit)." },
          },
        },
      },
      "/api/monitor/subscriptions": {
        get: {
          operationId: "monitorSubscriptions",
          summary: "This key's subscriptions and watchlists (API key)",
          tags: ["Monitoring"],
          responses: { "200": { description: "Subscriptions with per-wallet lastCheckedAt / nextCheckAt; the secret is never returned." } },
        },
      },
      "/api/monitor/subscriptions/{id}": {
        patch: {
          operationId: "monitorUpdate",
          summary: "Change webhook / threshold, add or remove wallets, rotate the secret (API key)",
          tags: ["Monitoring"],
          responses: { "200": { description: "Updated subscription; a rotated secret is shown once." } },
        },
        delete: {
          operationId: "monitorDelete",
          summary: "Stop monitoring and remove the watchlist (history is retained)",
          tags: ["Monitoring"],
          responses: { "200": { description: "Deleted." } },
        },
      },
      "/api/monitor/history": {
        get: {
          operationId: "monitorHistory",
          summary: "Attested time series for one watched wallet (API key)",
          description:
            "Sparse observations — baseline / change / event / weekly heartbeat — each with its leaf hash and, after the daily Merkle anchor, the on-ledger anchor " +
            "(verify at /api/attest/verify?queryId={observationId}). Shows observation points, not proof of continuous coverage. Params: subject (required), limit, before.",
          tags: ["Monitoring"],
          responses: { "200": { description: "Observations + coverage note." }, "404": { description: "not_watched" } },
        },
      },
      "/api/monitor/events": {
        get: {
          operationId: "monitorEvents",
          summary: "The events a webhook would push, readable back (API key)",
          tags: ["Monitoring"],
          responses: { "200": { description: "Events with delivery state." } },
        },
      },

      "/api/x402/lending/exposure": {
        get: {
          operationId: "x402LendingExposure",
          summary: "XLS-66 cross-broker lending exposure — full detail (x402, $0.01 USDC on Base or RLUSD on XRPL)",
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
            "402": { description: "Payment Required — x402 challenge. Pay EITHER in USDC on Base (v1 body; retry with X-PAYMENT) OR in RLUSD on the XRP Ledger (v2: PAYMENT-REQUIRED header, network xrpl:0; retry with PAYMENT-SIGNATURE, result wrapped as { data, x402 })." },
            "503": { description: "LendingProtocol (XLS-66) not yet enabled on mainnet." },
          },
        },
      },

      "/api/x402/lending/underwrite": {
        get: {
          operationId: "x402LendingUnderwrite",
          summary: "XLS-66 underwriting inputs — full bundle (x402, $0.05 USDC on Base or RLUSD on XRPL)",
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
            "402": { description: "Payment Required — x402 challenge. Pay EITHER in USDC on Base (v1 body; retry with X-PAYMENT) OR in RLUSD on the XRP Ledger (v2: PAYMENT-REQUIRED header, network xrpl:0; retry with PAYMENT-SIGNATURE, result wrapped as { data, x402 })." },
            "503": { description: "LendingProtocol (XLS-66) not yet enabled — body carries the live XRPLScore + OFAC screening." },
          },
        },
      },

      "/api/x402/usdc/score": {
        post: {
          operationId: "x402UsdcScore",
          summary: "XRPLScore — per-call, agent-priced (x402, $0.02 USDC on Base or RLUSD on XRPL)",
          description:
            "The same 300–850 score and 8-signal breakdown as /api/x402/score, priced for agents at " +
            "$0.02 per call — the same price as GET /api/x402/score — payable on either rail: USDC on Base (x402 v1, X-PAYMENT) or " +
            "RLUSD on the XRP Ledger (x402 v2 via t54: PAYMENT-REQUIRED header, retry with PAYMENT-SIGNATURE; response wrapped as { data, x402 }). " +
            "POST a JSON body {\"wallet\":\"r...\"}. No signup.",
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
            price: { mode: "fixed", currency: "USD", amount: "0.020000" },
            protocols: [{ x402: {} }],
            description: "Per-call wallet score, $0.02 in USDC on Base (CDP) or RLUSD on XRPL (t54), one price on every rail.",
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

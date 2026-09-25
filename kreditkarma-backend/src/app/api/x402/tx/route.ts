// src/app/api/x402/tx/route.ts
// The signable transaction for one XRPL service, delivered ONLY after an x402 payment.
//
// PRICE = the storefront list price of the requested service (src/lib/servicePrices.ts, USD = RLUSD = USDC). One price
// table, so an agent can never buy the same transaction for less than the storefront charges.
//
// TWO RAILS on one URL (src/lib/x402Dual.ts): RLUSD on XRPL (x402 v2, t54) or USDC on Base (x402 v1, CDP), same face value.
//
// AGENT-SAFE: the txjson is BUILT in the handler, before settlement — a missing-param, unknown-service or unconfirmed
// caution-tier request costs the caller nothing and is retryable. Idempotent replay on retry.
//
// CAUTION-TIER services (multisig lockdown, No Freeze, MPT issuance…) mirror the storefront: the first request is refused
// with the irreversibility copy (HTTP 409, `confirmation_required`, NOT charged); the wallet owner reads it and the caller
// repeats the request with confirmCaution=true.
//
// Free description of a service (no txjson): MCP tool preview_xrpl_transaction / POST /api/execute/preview.
import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "x402-next";
import { BASE_PAY_TO, BASE_NETWORK, cdpFacilitator } from "@/lib/x402Base";
import { dualX402 } from "@/lib/x402Dual";
import { TREASURY_ADDRESS } from "@/lib/paycall";
import { priceUsd } from "@/lib/pricing";
import { buildServiceTx } from "@/app/api/execute/txBuilder";
import { buildContextFromView, mptRegimeFor, permanenceNotice } from "@/lib/mptPermanence";
import { BUILDABLE_SERVICE_IDS } from "@/app/api/execute/serviceCatalog";
import { TX_SCHEMA } from "@/lib/x402Schemas";
import { confirmationFor, TX_RESERVED_QUERY_KEYS } from "@/lib/txPurchase";
import { isValidXrplAddress } from "@/lib/address";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KNOWN = new Set(BUILDABLE_SERVICE_IDS);
const DEFAULT_PRODUCT = "checkcreate"; // what a bare discovery probe (no productId) is quoted for
const isAddr = (v: string) => isValidXrplAddress(v);

const productOf = (req: Request) => (new URL(req.url).searchParams.get("productId") ?? DEFAULT_PRODUCT).trim().toLowerCase();
/** Storefront price of the requested service. Only called for known services (refuse() rejects the rest first). */
const priceOf = (req: Request) => priceUsd(productOf(req)) ?? priceUsd(DEFAULT_PRODUCT)!;

function extractParams(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) {
    if (TX_RESERVED_QUERY_KEYS.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

const fail = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error, message, ...extra }, { status });

// Runs on BOTH rails, only after the payment has been verified and before it is settled.
const core = async (req: NextRequest): Promise<NextResponse<unknown>> => {
  const url = new URL(req.url);
  const productId = productOf(req);
  const account = url.searchParams.get("account");
  if (!KNOWN.has(productId)) return fail(404, "bad_request", `Unknown productId "${productId}". See /api/mcp list_xrpl_services.`);
  if (!account || !isAddr(account)) return fail(400, "bad_request", "Provide &account=r... (the signer).");

  const params = extractParams(url);
  const view = await mptRegimeFor(productId); // MPT issuance only; null for every other product
  const built = await buildServiceTx(productId, account, params, view ? buildContextFromView(view) : undefined);
  if (!built.ok) {
    if (built.tier === "blocked") return fail(403, "bad_request", built.error ?? "This operation is disabled for safety.", { tier: "blocked" });
    const need = built.needsParams?.length ? ` Missing params: ${built.needsParams.join(", ")}.` : "";
    return fail(422, "bad_request", `${built.error ?? "Could not build the transaction."}${need}`, built.needsParams?.length ? { needsParams: built.needsParams } : {});
  }

  const tier = built.tier ?? "safe";
  if (tier === "caution" && url.searchParams.get("confirmCaution") !== "true") {
    const conf = confirmationFor(productId, params, tier, view, built.txjson as Record<string, unknown>);
    return fail(409, "confirmation_required", conf?.warning ?? "This service needs the wallet owner's confirmation. You were not charged.", { label: built.label, tier, ...conf });
  }

  return NextResponse.json({
    productId,
    label: built.label ?? productId,
    tier,
    txjson: built.txjson,
    // Several-transaction services: sign them IN ORDER (txjson is the first).
    ...(built.steps && built.steps.length > 1 ? { transactions: built.steps.map((s) => ({ id: s.id, label: s.label, txjson: s.txjson })) } : {}),
    ...(view ? permanenceNotice(view) : {}),
    signWith: account,
    instructions:
      "Check that every transaction's Account equals signWith, then sign with your own XRPL wallet and submit it (multi-step: in order, each validated before the next). XRPLHub never signs for anyone.",
  });
};

// Refuse a request that has nothing to pay against BEFORE any challenge: an unknown service, or a mistyped account.
// A bare request (no productId, no account) still gets the 402 so discovery crawlers can index the route.
const refuse = (req: NextRequest): Response | null => {
  const url = new URL(req.url);
  const explicit = url.searchParams.get("productId");
  if (explicit !== null && !KNOWN.has(explicit.trim().toLowerCase())) {
    return fail(404, "bad_request", `Unknown productId "${explicit.slice(0, 40)}". See /api/mcp list_xrpl_services.`);
  }
  const account = (url.searchParams.get("account") ?? "").trim();
  if (account && !isAddr(account)) {
    return fail(400, "bad_request", "Provide a valid XRPL account (?account=r...) — an r-address whose checksum verifies. Nothing was priced or charged.");
  }
  return null;
};

// One x402-next wrapper per service (its price is fixed at construction), created on first use.
const baseWrappers = new Map<string, (req: NextRequest) => Promise<Response>>();
function baseFor(productId: string): (req: NextRequest) => Promise<Response> {
  let w = baseWrappers.get(productId);
  if (!w) {
    w = withX402(
      core,
      BASE_PAY_TO,
      {
        price: `$${priceUsd(productId)}`,
        network: BASE_NETWORK,
        config: {
          description: TX_SCHEMA.description,
          mimeType: "application/json",
          discoverable: true,
          outputSchema: TX_SCHEMA.output as object,
        },
      },
      cdpFacilitator
    );
    baseWrappers.set(productId, w);
  }
  return w;
}

export const GET = dualX402({
  resource: "/api/x402/tx",
  plan: (req) => `x402:tx:${productOf(req)}`,
  amountRlusd: priceOf,
  amountUsdc: priceOf,
  name: "XRPLHub — Prebuilt XRPL Transaction",
  description: TX_SCHEMA.description,
  schemas: TX_SCHEMA,
  base: (req) => baseFor(productOf(req))(req),
  core,
  refuse,
});

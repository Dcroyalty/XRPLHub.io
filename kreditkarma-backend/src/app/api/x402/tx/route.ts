// src/app/api/x402/tx/route.ts
// Prebuilt XRPL transaction (35 actions) over the official x402 v2 protocol.
//
// AGENT-SAFE (serveX402Paid): schema in the 402; the txjson is BUILT in the
// handler, before settlement — a missing-param or unknown-product failure
// costs the caller nothing and is retryable. Idempotent replay on retry.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { PRICE_PER_TX_PRODUCT_RLUSD, TREASURY_ADDRESS } from "@/lib/paycall";
import { buildServiceTx } from "@/app/api/execute/txBuilder";
import { BUILDABLE_SERVICE_IDS } from "@/app/api/execute/serviceCatalog";
import { rlusdRequirements, serveX402Paid, type HandlerResult } from "@/lib/x402";
import { TX_SCHEMA } from "@/lib/x402Schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESOURCE = "/api/x402/tx";
const KNOWN = new Set(BUILDABLE_SERVICE_IDS);
const isAddr = (v: string) => v.startsWith("r") && v.length >= 25 && v.length <= 35;

function extractParams(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) {
    if (k === "productId" || k === "account") continue;
    out[k] = v;
  }
  return out;
}

export async function GET(req: Request) {
  if (!TREASURY_ADDRESS) return NextResponse.json({ error: "misconfigured" }, { status: 500 });
  const url = new URL(req.url);
  const productId = (url.searchParams.get("productId") ?? "checkcreate").toLowerCase();
  const account = url.searchParams.get("account");

  // Unknown product is a client error the caller should learn about BEFORE
  // building a payment — reject it without going through the paid flow.
  if (req.headers.get("PAYMENT-SIGNATURE") && !KNOWN.has(productId)) {
    return NextResponse.json({ error: "bad_request", message: `Unknown productId "${productId}". See /api/mcp list_xrpl_services.` }, { status: 404 });
  }

  return serveX402Paid({
    req,
    prisma,
    resource: RESOURCE,
    plan: `x402:tx:${KNOWN.has(productId) ? productId : "unknown"}`,
    amountRlusd: PRICE_PER_TX_PRODUCT_RLUSD,
    challengeDescription: TX_SCHEMA.description,
    requirements: (invoiceId) =>
      rlusdRequirements({
        payTo: TREASURY_ADDRESS,
        amountRlusd: PRICE_PER_TX_PRODUCT_RLUSD,
        invoiceId,
        name: "XRPLHub — Prebuilt XRPL Transaction",
        description: TX_SCHEMA.description,
        schemas: TX_SCHEMA,
      }),
    handler: async (): Promise<HandlerResult> => {
      if (!KNOWN.has(productId)) {
        return { ok: false, code: "bad_request", status: 404, message: `Unknown productId "${productId}". See /api/mcp list_xrpl_services.` };
      }
      if (!account || !isAddr(account)) {
        return { ok: false, code: "bad_request", status: 400, message: "Provide &account=r... (the signer)." };
      }
      const built = buildServiceTx(productId, account, extractParams(url));
      if (!built.ok) {
        const need = built.needsParams?.length ? ` Missing params: ${built.needsParams.join(", ")}.` : "";
        return { ok: false, code: "bad_request", status: 422, message: `${built.error ?? "Could not build the transaction."}${need}` };
      }
      return {
        ok: true,
        data: {
          productId,
          label: built.label ?? productId,
          tier: built.tier ?? "safe",
          txjson: built.txjson,
          signWith: account,
          instructions: "Sign this txjson with your own XRPL wallet and submit it. This service never signs for anyone.",
        },
      };
    },
  });
}

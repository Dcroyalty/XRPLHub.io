// src/app/api/x402/report/route.ts
// Full Wallet Risk Report over the official x402 v2 protocol (t54, XRPL).
//
// AGENT-SAFE (serveX402Paid): schema in the 402; settle only after
// buildWalletReport() succeeds; idempotent replay on retry.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { isValidXrplAddress, AccountNotFoundError } from "@/lib/engine";
import { buildWalletReport } from "@/lib/report";
import { PRICE_PER_PRODUCT_RLUSD, TREASURY_ADDRESS } from "@/lib/paycall";
import { rlusdRequirements, serveX402Paid, type HandlerResult } from "@/lib/x402";
import { REPORT_SCHEMA } from "@/lib/x402Schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESOURCE = "/api/x402/report";

export async function GET(req: Request) {
  if (!TREASURY_ADDRESS) return NextResponse.json({ error: "misconfigured" }, { status: 500 });
  const wallet = new URL(req.url).searchParams.get("wallet");

  return serveX402Paid({
    req,
    prisma,
    resource: RESOURCE,
    plan: "x402:report",
    amountRlusd: PRICE_PER_PRODUCT_RLUSD,
    challengeDescription: REPORT_SCHEMA.description,
    requirements: (invoiceId) =>
      rlusdRequirements({
        payTo: TREASURY_ADDRESS,
        amountRlusd: PRICE_PER_PRODUCT_RLUSD,
        invoiceId,
        name: "XRPLHub — Full Wallet Risk Report",
        description: REPORT_SCHEMA.description,
        schemas: REPORT_SCHEMA,
      }),
    handler: async (): Promise<HandlerResult> => {
      if (!wallet || !isValidXrplAddress(wallet)) {
        return { ok: false, code: "bad_request", status: 400, message: "Provide a valid XRPL wallet (&wallet=r...)." };
      }
      try {
        return { ok: true, data: await buildWalletReport(wallet) };
      } catch (err) {
        if (err instanceof AccountNotFoundError) {
          return { ok: false, code: "account_not_found", status: 404, message: "That wallet is not an activated account on XRPL mainnet." };
        }
        throw err;
      }
    },
  });
}

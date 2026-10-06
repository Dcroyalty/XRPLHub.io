// src/app/api/x402/precheck/route.ts
// GET /api/x402/precheck?destination=r...&amount=&currency=XRP|RLUSD&destinationTag=&from=
// The AGENT PAYMENT PRE-CHECK (src/lib/paymentPrecheck.ts): before paying an XRPL address, one call returns a verdict
// (block / caution / proceed) by fixed published rules, with the destination's XRPLScore, a sanctions screen against
// every list we hold (with its own anchored receipt), account age + ledger flags, and the reasons the ledger would
// reject the payment. $0.03 per call on EITHER x402 rail: USDC on Base (X-PAYMENT, CDP) or RLUSD on XRPL
// (PAYMENT-SIGNATURE, t54). Same price as a score ($0.02) plus a screen ($0.01) bought separately.
//
// A malformed destination is refused BEFORE the payment challenge (nothing to pay for). A bare request (no destination)
// still gets the 402 so x402 discovery crawlers can index it.

import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "x402-next";
import { BASE_PAY_TO, BASE_NETWORK, PRICE_PER_PRECHECK_USDC, cdpFacilitator } from "@/lib/x402Base";
import { dualX402 } from "@/lib/x402Dual";
import { PRICE_PER_PRECHECK_RLUSD } from "@/lib/paycall";
import { prisma } from "@/lib/xrplscore-db";
import { PRECHECK_INPUT_SCHEMA, PRECHECK_OUTPUT_SCHEMA, PrecheckInputError, parsePrecheckInput, runPaymentPrecheck } from "@/lib/paymentPrecheck";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const DESCRIPTION =
  "Agent payment pre-check: before paying an XRPL address, get one verdict (block / caution / proceed) by fixed " +
  "published rules — the destination's XRPLScore, a sanctions screen against every list held (with an anchored " +
  "receipt), account age and ledger flags, and whether the ledger would reject the payment (missing tag, deposit " +
  "auth, no trust line, unfunded account). Not advice. GET ?destination=r...&amount=&currency=XRP|RLUSD&destinationTag=&from=";

const handler = async (req: NextRequest): Promise<NextResponse<unknown>> => {
  let input;
  try {
    input = parsePrecheckInput(Object.fromEntries(req.nextUrl.searchParams));
  } catch (e) {
    return NextResponse.json({ error: "bad_request", message: e instanceof Error ? e.message : "bad input" }, { status: 400 });
  }
  try {
    return NextResponse.json(await runPaymentPrecheck(prisma, input, "x402:precheck"));
  } catch (e) {
    return NextResponse.json({ error: "precheck_failed", message: e instanceof Error ? e.message : "failed", retryable: true }, { status: 503, headers: { "Retry-After": "15" } });
  }
};

const paidGET = withX402(
  handler,
  BASE_PAY_TO,
  {
    price: `$${PRICE_PER_PRECHECK_USDC}`,
    network: BASE_NETWORK,
    config: { description: DESCRIPTION, mimeType: "application/json", discoverable: true, outputSchema: PRECHECK_OUTPUT_SCHEMA },
  },
  cdpFacilitator
);

const refuse = async (req: NextRequest): Promise<Response | null> => {
  const sp = req.nextUrl.searchParams;
  if (!sp.get("destination") && !sp.get("address")) return null; // bare probe: let discovery see the 402
  try {
    parsePrecheckInput(Object.fromEntries(sp));
    return null;
  } catch (e) {
    if (e instanceof PrecheckInputError) {
      return NextResponse.json({ error: "bad_request", message: `${e.message}. Nothing was checked or charged.` }, { status: 400 });
    }
    return null;
  }
};

export const GET = dualX402({
  resource: "/api/x402/precheck",
  plan: "x402:precheck",
  amountRlusd: PRICE_PER_PRECHECK_RLUSD,
  amountUsdc: PRICE_PER_PRECHECK_USDC,
  name: "Agent payment pre-check",
  description: DESCRIPTION,
  schemas: { input: PRECHECK_INPUT_SCHEMA, output: PRECHECK_OUTPUT_SCHEMA },
  base: paidGET,
  core: handler,
  refuse,
  deliverOnlyIfSettled: true,
});

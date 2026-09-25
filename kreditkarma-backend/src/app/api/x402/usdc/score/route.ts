// src/app/api/x402/usdc/score/route.ts
// XRPLScore over x402, priced for agents: $0.02 per call, on EITHER rail (src/lib/x402Dual.ts):
//   - USDC on Base (x402 v1, CDP, X-PAYMENT header) — the original behaviour of this route, or
//   - RLUSD on the XRP Ledger (x402 v2, t54, PAYMENT-SIGNATURE header) — response wrapped as { data, x402 }.
// ONE PRODUCT, ONE PRICE, EVERY RAIL: the same score costs the same $0.02 here and at GET /api/x402/score (RLUSD/XRPL).
// (Until 2026-09-25 this route was $0.01 on Base only.) The path keeps its historical "usdc" segment so existing Base
// clients and listings keep working; the two routes are the same product with different request shapes (POST body vs GET query).
//
// This is the cheap entry point — the $29/$149/$499 routes under /api/checkout/usdc/{starter,growth,scale}
// are human subscription pricing and stay exactly as they are (agents buy per call, not a monthly plan).
//
// Same scoring pipeline as GET /api/x402/score (src/lib/engine.ts -> src/lib/xrplscore.ts) — same mainnet nodes, same
// 8 signals, same 300–850 math. A wallet gets the same score whichever rail paid for it.
import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "x402-next";
import { BASE_PAY_TO, BASE_NETWORK, PRICE_PER_SCORE_USDC, cdpFacilitator } from "@/lib/x402Base";
import { dualX402 } from "@/lib/x402Dual";
import { PRICE_PER_SCORE_RLUSD } from "@/lib/paycall";
import { computeScore, isValidXrplAddress, AccountNotFoundError, XrplUnavailableError } from "@/lib/engine";
import { walletProp, SCORE_OUTPUT_SCHEMA } from "@/lib/scoreSchema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DESCRIPTION =
  "Get a 300–850 on-chain creditworthiness score for one XRPL wallet from 8 signals (account age, " +
  "tx history, financial health, tokens, DEX, AMM, security, NFTs). $0.02 per call, payable in USDC on Base " +
  "or RLUSD on XRPL — the same price as GET /api/x402/score. " +
  'POST JSON body {"wallet":"r..."}. No signup.';

const handler = async (req: NextRequest): Promise<NextResponse<unknown>> => {
  const body = (await req.json().catch(() => null)) as { wallet?: unknown } | null;
  const wallet = typeof body?.wallet === "string" ? body.wallet.trim() : "";
  if (!isValidXrplAddress(wallet)) {
    return NextResponse.json(
      { error: "bad_request", message: 'Provide a valid XRPL wallet as JSON: {"wallet":"r..."}' },
      { status: 400 }
    );
  }
  try {
    const result = await computeScore(wallet);
    return NextResponse.json({ data: result });
  } catch (err) {
    if (err instanceof AccountNotFoundError) {
      return NextResponse.json(
        { error: "account_not_found", message: "That wallet is not an activated account on XRPL mainnet." },
        { status: 404 }
      );
    }
    if (err instanceof XrplUnavailableError) {
      // Not scored — one or more XRPL calls could not be read. Retryable.
      return NextResponse.json(
        { error: "xrpl_unavailable", message: err.message, failedCalls: err.failedCalls, retryable: true },
        { status: 503, headers: { "Retry-After": "15" } }
      );
    }
    return NextResponse.json(
      { error: "scoring_failed", message: err instanceof Error ? err.message : "scoring failed" },
      { status: 500 }
    );
  }
};

const paidPOST = withX402(
  handler,
  BASE_PAY_TO,
  {
    price: `$${PRICE_PER_SCORE_USDC}`,
    network: BASE_NETWORK,
    config: {
      description: DESCRIPTION,
      mimeType: "application/json",
      discoverable: true,
      inputSchema: {
        bodyType: "json",
        bodyFields: { wallet: walletProp },
      },
      outputSchema: SCORE_OUTPUT_SCHEMA,
    },
  },
  cdpFacilitator
);

// A MISTYPED address is refused BEFORE the payment challenge: no 402 to pay against, no receipt, no attestation, no charge.
// A bare request (no address) still gets the 402 challenge, so x402 discovery crawlers can index the route.
// (The handler above re-checks it too; that check alone runs only after the payment was verified.)
async function readWallet(req: NextRequest): Promise<string> {
  const body = (await req.clone().json().catch(() => null)) as { wallet?: unknown } | null;
  return typeof body?.wallet === "string" ? body.wallet.trim() : "";
}

const refuse = async (req: NextRequest): Promise<Response | null> => {
  const supplied = await readWallet(req);
  if (supplied && !isValidXrplAddress(supplied)) {
    return NextResponse.json(
      { error: "bad_request", message: 'Provide a valid XRPL wallet as JSON {"wallet":"r..."} — an r-address whose checksum verifies. Nothing was screened, priced or charged.' },
      { status: 400 }
    );
  }
  return null;
};

export const POST = dualX402({
  resource: "/api/x402/usdc/score",
  plan: "x402:score-post",
  amountRlusd: PRICE_PER_SCORE_RLUSD,
  amountUsdc: PRICE_PER_SCORE_USDC,
  name: "XRPLScore — wallet risk score",
  description: DESCRIPTION,
  schemas: {
    input: { type: "object", properties: { wallet: walletProp }, required: ["wallet"], description: "JSON request body." },
    output: SCORE_OUTPUT_SCHEMA,
  },
  base: paidPOST,
  core: handler,
  // The Base body is { data: result }; on XRPL the envelope is { data: result, x402 }, exactly like GET /api/x402/score.
  xrplData: (body) => (body && typeof body === "object" && "data" in body ? (body as { data: unknown }).data : body),
  refuse,
});

// src/app/api/x402/score/route.ts
// XRPLScore over the official x402 v2 protocol (XRPL exact scheme, t54).
//
// AGENT-SAFE (serveX402Paid): the 402 challenge carries full input+output
// schema; settlement fires ONLY after computeScore() succeeds; a retried
// request (Idempotency-Key or the invoiceId) replays the stored response
// instead of paying again. A caller can never pay twice or pay for nothing.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { computeScore, isValidXrplAddress, AccountNotFoundError } from "@/lib/engine";
import { PRICE_PER_SCORE_RLUSD, TREASURY_ADDRESS } from "@/lib/paycall";
import { rlusdRequirements, serveX402Paid, type HandlerResult } from "@/lib/x402";
import { SCORE_SCHEMA } from "@/lib/x402Schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESOURCE = "/api/x402/score";

export async function GET(req: Request) {
  if (!TREASURY_ADDRESS) return NextResponse.json({ error: "misconfigured" }, { status: 500 });
  const wallet = new URL(req.url).searchParams.get("wallet");

  return serveX402Paid({
    req,
    prisma,
    resource: RESOURCE,
    plan: "x402:score",
    amountRlusd: PRICE_PER_SCORE_RLUSD,
    challengeDescription: `XRPLScore 300-850 wallet risk score${wallet ? " for " + wallet : ""}`,
    requirements: (invoiceId) =>
      rlusdRequirements({
        payTo: TREASURY_ADDRESS,
        amountRlusd: PRICE_PER_SCORE_RLUSD,
        invoiceId,
        name: "XRPLScore — Wallet Risk Score",
        description: SCORE_SCHEMA.description,
        schemas: SCORE_SCHEMA,
      }),
    handler: async (): Promise<HandlerResult> => {
      if (!wallet || !isValidXrplAddress(wallet)) {
        return { ok: false, code: "bad_request", status: 400, message: "Provide a valid XRPL wallet (&wallet=r...)." };
      }
      try {
        return { ok: true, data: await computeScore(wallet) };
      } catch (err) {
        if (err instanceof AccountNotFoundError) {
          return { ok: false, code: "account_not_found", status: 404, message: "That wallet is not an activated account on XRPL mainnet." };
        }
        throw err; // serveX402Paid turns this into handler_failed (not charged, retryable)
      }
    },
  });
}

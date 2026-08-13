// src/app/api/v1/pay-per-score/route.ts
// Pay-per-call wallet score — x402-style, for autonomous AI agents.
// No API key, no account. One RLUSD micropayment = one score.
//
// FLOW (two round trips, HTTP-native):
//   1) GET /api/v1/pay-per-score?wallet=r...
//        -> 402 Payment Required + JSON: price, treasury address, destination
//           tag, issuer/currency, and a quoteId. The agent pays this.
//   2) GET /api/v1/pay-per-score?wallet=r...&quoteId=<id>
//        -> we check the ledger for the 0.05 RLUSD payment carrying that tag.
//           Paid  -> 200 + the score.
//           Unpaid-> 402 again (agent waits a beat and retries).
//
// Reuses the exact payment-detection flow proven working on the checkout:
// findPayment() reads meta.delivered_amount and matches the destination tag.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { computeScore, isValidXrplAddress } from "@/lib/engine";
import { findPayment } from "@/lib/rlusd";
import {
  PRICE_PER_SCORE_RLUSD,
  QUOTE_TTL_MINUTES,
  TREASURY_ADDRESS,
  RLUSD_ISSUER,
  RLUSD_CURRENCY_HEX,
} from "@/lib/paycall";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TAG = 4_294_967_295;
function randomTag(): number {
  return 1 + Math.floor(Math.random() * (MAX_TAG - 1));
}

// The 402 body an agent reads to know exactly what to pay.
function paymentRequired(quote: {
  quoteId: string;
  wallet: string;
  destinationTag: number;
  expiresAt: Date;
}) {
  return NextResponse.json(
    {
      error: "payment_required",
      x402: {
        price: PRICE_PER_SCORE_RLUSD.toFixed(6),
        currency: "RLUSD",
        currencyHex: RLUSD_CURRENCY_HEX,
        issuer: RLUSD_ISSUER,
        network: "xrpl-mainnet",
        payTo: TREASURY_ADDRESS,
        destinationTag: quote.destinationTag,
        quoteId: quote.quoteId,
        expiresAt: quote.expiresAt.toISOString(),
      },
      instructions:
        `Pay ${PRICE_PER_SCORE_RLUSD} RLUSD to ${TREASURY_ADDRESS} with ` +
        `destination tag ${quote.destinationTag}, then retry this URL with ` +
        `&quoteId=${quote.quoteId} to receive the score.`,
      scored_wallet: quote.wallet,
    },
    { status: 402 }
  );
}

export async function GET(req: Request) {
  if (!TREASURY_ADDRESS) {
    return NextResponse.json(
      { error: "misconfigured", message: "TREASURY_ADDRESS not set." },
      { status: 500 }
    );
  }

  const url = new URL(req.url);
  const wallet = url.searchParams.get("wallet");
  const quoteId = url.searchParams.get("quoteId");

  if (!wallet || !isValidXrplAddress(wallet)) {
    return NextResponse.json(
      { error: "bad_request", message: "Provide a valid XRPL wallet address." },
      { status: 400 }
    );
  }

  // ---- Round 1: no quoteId yet -> create a quote, return 402 ----
  if (!quoteId) {
    let quote = null;
    for (let i = 0; i < 5 && !quote; i++) {
      try {
        quote = await prisma.invoice.create({
          data: {
            plan: "paycall:score",          // reuse Invoice table; plan marks the kind
            amountRlusd: PRICE_PER_SCORE_RLUSD,
            destinationTag: randomTag(),
            status: "pending",
            expiresAt: new Date(Date.now() + QUOTE_TTL_MINUTES * 60_000),
          },
        });
      } catch {
        /* tag collision, retry */
      }
    }
    if (!quote) {
      return NextResponse.json(
        { error: "retry", message: "Could not allocate a quote. Try again." },
        { status: 503 }
      );
    }
    // Stash the wallet to score on the quote (txHash column unused until paid).
    return paymentRequired({
      quoteId: quote.id,
      wallet,
      destinationTag: quote.destinationTag,
      expiresAt: quote.expiresAt,
    });
  }

  // ---- Round 2: quoteId present -> verify payment, then score ----
  const quote = await prisma.invoice.findUnique({ where: { id: quoteId } });
  if (!quote || quote.plan !== "paycall:score") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (quote.expiresAt < new Date() && quote.status !== "paid") {
    return NextResponse.json(
      { error: "quote_expired", message: "Quote expired. Request a new one." },
      { status: 410 }
    );
  }

  // Already paid + already scored once? Re-scoring is cheap; just return it.
  if (quote.status !== "paid") {
    const match = await findPayment(
      quote.destinationTag,
      Number(quote.amountRlusd)
    );
    if (!match.paid) {
      // Not seen yet — tell the agent to wait and retry.
      return paymentRequired({
        quoteId: quote.id,
        wallet,
        destinationTag: quote.destinationTag,
        expiresAt: quote.expiresAt,
      });
    }
    // Mark paid (guard against double-processing on races).
    await prisma.invoice
      .update({
        where: { id: quote.id, status: "pending" },
        data: {
          status: "paid",
          txHash: match.txHash,
          deliveredRlusd: match.deliveredRlusd,
          paidAt: new Date(),
        },
      })
      .catch(() => {});
  }

  // Paid — compute and return the score.
  try {
    const result = await computeScore(wallet);
    return NextResponse.json(
      {
        data: result,
        paid: PRICE_PER_SCORE_RLUSD.toFixed(6) + " RLUSD",
        quoteId: quote.id,
      },
      { headers: { "Cache-Control": "private, max-age=60" } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "scoring failed";
    return NextResponse.json({ error: "scoring_failed", message }, { status: 500 });
  }
}

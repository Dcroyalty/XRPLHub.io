// src/app/api/v1/wallet-report/route.ts
// Full Wallet Risk Report — x402 pay-per-call bot product. $0.25 RLUSD.
// Same two-round flow as /pay-per-score, richer payload. No account, no key.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { isValidXrplAddress } from "@/lib/engine";
import { buildWalletReport } from "@/lib/report";
import { findPayment } from "@/lib/rlusd";
import {
  PRICE_PER_PRODUCT_RLUSD,
  QUOTE_TTL_MINUTES,
  TREASURY_ADDRESS,
  RLUSD_ISSUER,
  RLUSD_CURRENCY_HEX,
} from "@/lib/paycall";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TAG = 4_294_967_295;
const randomTag = () => 1 + Math.floor(Math.random() * (MAX_TAG - 1));

function paymentRequired(q: {
  quoteId: string; wallet: string; destinationTag: number; expiresAt: Date;
}) {
  return NextResponse.json(
    {
      error: "payment_required",
      x402: {
        product: "full-wallet-risk-report",
        price: PRICE_PER_PRODUCT_RLUSD.toFixed(6),
        currency: "RLUSD",
        currencyHex: RLUSD_CURRENCY_HEX,
        issuer: RLUSD_ISSUER,
        network: "xrpl-mainnet",
        payTo: TREASURY_ADDRESS,
        destinationTag: q.destinationTag,
        quoteId: q.quoteId,
        expiresAt: q.expiresAt.toISOString(),
      },
      instructions:
        `Pay ${PRICE_PER_PRODUCT_RLUSD} RLUSD to ${TREASURY_ADDRESS} with ` +
        `destination tag ${q.destinationTag}, then retry with ` +
        `&quoteId=${q.quoteId} to receive the full report.`,
      scored_wallet: q.wallet,
    },
    { status: 402 }
  );
}

export async function GET(req: Request) {
  if (!TREASURY_ADDRESS) {
    return NextResponse.json({ error: "misconfigured" }, { status: 500 });
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

  // Round 1 — quote + 402
  if (!quoteId) {
    let quote = null;
    for (let i = 0; i < 5 && !quote; i++) {
      try {
        quote = await prisma.invoice.create({
          data: {
            plan: "paycall:report",
            amountRlusd: PRICE_PER_PRODUCT_RLUSD,
            destinationTag: randomTag(),
            status: "pending",
            expiresAt: new Date(Date.now() + QUOTE_TTL_MINUTES * 60_000),
          },
        });
      } catch { /* tag collision */ }
    }
    if (!quote) {
      return NextResponse.json({ error: "retry" }, { status: 503 });
    }
    return paymentRequired({
      quoteId: quote.id, wallet,
      destinationTag: quote.destinationTag, expiresAt: quote.expiresAt,
    });
  }

  // Round 2 — verify payment, deliver report
  const quote = await prisma.invoice.findUnique({ where: { id: quoteId } });
  if (!quote || quote.plan !== "paycall:report") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (quote.expiresAt < new Date() && quote.status !== "paid") {
    return NextResponse.json({ error: "quote_expired" }, { status: 410 });
  }

  if (quote.status !== "paid") {
    const match = await findPayment(quote.destinationTag, Number(quote.amountRlusd));
    if (!match.paid) {
      return paymentRequired({
        quoteId: quote.id, wallet,
        destinationTag: quote.destinationTag, expiresAt: quote.expiresAt,
      });
    }
    await prisma.invoice.update({
      where: { id: quote.id, status: "pending" },
      data: {
        status: "paid", txHash: match.txHash,
        deliveredRlusd: match.deliveredRlusd, paidAt: new Date(),
      },
    }).catch(() => {});
  }

  try {
    const report = await buildWalletReport(wallet);
    return NextResponse.json(
      { data: report, paid: PRICE_PER_PRODUCT_RLUSD.toFixed(6) + " RLUSD", quoteId: quote.id },
      { headers: { "Cache-Control": "private, max-age=60" } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "report failed";
    return NextResponse.json({ error: "report_failed", message }, { status: 500 });
  }
}

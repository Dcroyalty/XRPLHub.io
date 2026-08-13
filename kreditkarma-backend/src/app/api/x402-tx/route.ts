// src/app/api/x402-tx/route.ts
// PREBUILT TRANSACTION PRODUCTS for bots — pay-per-call, $0.49 RLUSD each.
//
// This turns XRPLHub's 35 human services into BOT inventory. A bot names a
// service (productId) + its own wallet + params, pays 0.49 RLUSD, and gets
// back a ready-to-sign XRPL transaction (txjson) that it signs with its OWN
// wallet. We sell the ASSEMBLY — "we build the exact transaction, you sign it."
//
// Reuses:
//   - buildServiceTx()  from the existing execute engine (all 35 builders)
//   - findPayment()     the proven RLUSD destination-tag settlement flow
//
//   GET  /api/x402-tx
//        -> free catalog: every productId, its label, tier, required params.
//   GET  /api/x402-tx?productId=checkcreate&account=r...&<params>
//        no quoteId  -> 402 + price + destination tag + quoteId
//        with quoteId-> verify 0.49 RLUSD paid, then return the built txjson.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/xrplscore-db";
import { findPayment } from "@/lib/rlusd";
import {
  PRICE_PER_TX_PRODUCT_RLUSD,
  QUOTE_TTL_MINUTES,
  TREASURY_ADDRESS,
  RLUSD_ISSUER,
  RLUSD_CURRENCY_HEX,
} from "@/lib/paycall";
import { buildServiceTx, productMeta } from "@/app/api/execute/txBuilder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The 35 product IDs the execute engine knows, with human labels for the
// catalog. (Keys must match the builders map in txBuilder.ts.)
const PRODUCTS: Record<string, string> = {
  checkcreate: "Create a Check",
  checkcash: "Cash a Check",
  checkcancel: "Cancel a Check",
  escrow: "Escrow Setup",
  paychannel: "Payment Channel",
  desttagreq: "Require Destination Tags",
  desttag: "Require Destination Tag",
  regkey: "Regular Key Rotator",
  rippling: "Rippling Controller",
  globalfreeze: "Global Freeze",
  freezeline: "Freeze a Trust Line",
  issuerdecl: "Issuer Trustless Declaration",
  issuercfg: "Full Issuer Config",
  dexorder: "DEX Order Builder",
  dextrade: "DEX Trade Execution",
  smartswap: "Smart Swap Router",
  ammlaunch: "AMM Pool Launch",
  ammentry: "AMM Liquidity Entry",
  tickets: "Ticket Batch Setup",
  nftmint: "NFT Minter",
  nftburn: "NFT Burn Certificate",
  nftoffer: "NFT Offer Creator",
  identity: "On-Chain Identity",
  did: "DID Creator",
  compliance: "Compliance Bundle",
  credentialissue: "Issue a Credential",
  permdomain: "Permissioned Domain",
};

const MAX_TAG = 4_294_967_295;
const randomTag = () => 1 + Math.floor(Math.random() * (MAX_TAG - 1));
const isAddr = (v: string) => v.startsWith("r") && v.length >= 25 && v.length <= 35;

// Pull params out of the query string (everything except our control keys).
function extractParams(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) {
    if (k === "productId" || k === "account" || k === "quoteId") continue;
    out[k] = v;
  }
  return out;
}

function paymentRequired(q: {
  quoteId: string; productId: string; destinationTag: number; expiresAt: Date;
}) {
  return NextResponse.json(
    {
      error: "payment_required",
      x402: {
        product: `prebuilt-tx:${q.productId}`,
        price: PRICE_PER_TX_PRODUCT_RLUSD.toFixed(6),
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
        `Pay ${PRICE_PER_TX_PRODUCT_RLUSD} RLUSD to ${TREASURY_ADDRESS} with ` +
        `destination tag ${q.destinationTag}, then retry with &quoteId=${q.quoteId} ` +
        `to receive the ready-to-sign transaction.`,
    },
    { status: 402 }
  );
}

export async function GET(req: Request) {
  if (!TREASURY_ADDRESS) {
    return NextResponse.json({ error: "misconfigured" }, { status: 500 });
  }

  const url = new URL(req.url);
  const productId = url.searchParams.get("productId");
  const account = url.searchParams.get("account");
  const quoteId = url.searchParams.get("quoteId");

  // ── Free catalog: list every product a bot can buy ──────────────────────
  if (!productId) {
    const catalog = Object.entries(PRODUCTS).map(([id, label]) => {
      const meta = productMeta(id);
      return { productId: id, label, tier: meta.tier, requiredParams: meta.needsParams };
    });
    return NextResponse.json(
      {
        service: "XRPLHub prebuilt-transaction products",
        price: PRICE_PER_TX_PRODUCT_RLUSD.toFixed(6) + " RLUSD each",
        howItWorks:
          "GET with productId + account + params -> 402 -> pay RLUSD -> " +
          "receive ready-to-sign txjson. Sign it with your own wallet.",
        products: catalog,
      },
      { headers: { "Cache-Control": "public, max-age=300" } }
    );
  }

  if (!PRODUCTS[productId]) {
    return NextResponse.json(
      { error: "unknown_product", message: `No product "${productId}". GET /api/x402-tx for the catalog.` },
      { status: 404 }
    );
  }
  if (!account || !isAddr(account)) {
    return NextResponse.json(
      { error: "bad_request", message: "Provide account=<your XRPL wallet r...> (the signer)." },
      { status: 400 }
    );
  }

  // ── Round 1: quote ──────────────────────────────────────────────────────
  if (!quoteId) {
    let quote = null;
    for (let i = 0; i < 5 && !quote; i++) {
      try {
        quote = await prisma.invoice.create({
          data: {
            plan: `paycall:tx:${productId}`,
            amountRlusd: PRICE_PER_TX_PRODUCT_RLUSD,
            destinationTag: randomTag(),
            status: "pending",
            expiresAt: new Date(Date.now() + QUOTE_TTL_MINUTES * 60_000),
          },
        });
      } catch { /* tag collision */ }
    }
    if (!quote) return NextResponse.json({ error: "retry" }, { status: 503 });
    return paymentRequired({
      quoteId: quote.id, productId,
      destinationTag: quote.destinationTag, expiresAt: quote.expiresAt,
    });
  }

  // ── Round 2: verify payment, build + return the transaction ─────────────
  const quote = await prisma.invoice.findUnique({ where: { id: quoteId } });
  if (!quote || quote.plan !== `paycall:tx:${productId}`) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (quote.expiresAt < new Date() && quote.status !== "paid") {
    return NextResponse.json({ error: "quote_expired" }, { status: 410 });
  }

  if (quote.status !== "paid") {
    const match = await findPayment(quote.destinationTag, Number(quote.amountRlusd));
    if (!match.paid) {
      return paymentRequired({
        quoteId: quote.id, productId,
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

  // Build the exact transaction on the bot's own wallet using YOUR engine.
  const built = buildServiceTx(productId, account, extractParams(url));
  if (!built.ok) {
    // Paid but missing params / blocked — tell the bot exactly what's wrong.
    return NextResponse.json(
      {
        error: "build_failed",
        reason: built.error,
        needsParams: built.needsParams ?? [],
        tier: built.tier ?? null,
        note: "Payment was received. Retry the same quoteId with the missing params.",
        quoteId: quote.id,
      },
      { status: 422 }
    );
  }

  return NextResponse.json(
    {
      data: {
        productId,
        label: built.label ?? PRODUCTS[productId],
        tier: built.tier ?? "safe",
        // The ready-to-sign transaction. The bot signs this with ITS wallet.
        txjson: built.txjson,
        signWith: account,
        instructions:
          "Sign this txjson with your own XRPL wallet and submit it to the ledger. " +
          "XRPLHub built it; you sign and broadcast.",
      },
      paid: PRICE_PER_TX_PRODUCT_RLUSD.toFixed(6) + " RLUSD",
      quoteId: quote.id,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

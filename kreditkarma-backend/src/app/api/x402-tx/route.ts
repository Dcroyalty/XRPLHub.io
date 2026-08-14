// src/app/api/x402-tx/route.ts
// PREBUILT TRANSACTION PRODUCTS for bots — pay-per-call, $0.49 RLUSD each.
// Returns a ready-to-sign XRPL txjson for any of 27 services.
//
// CRAWLER NOTE: a bare GET (no productId) now returns a 402 challenge so
// x402scan's probe succeeds. The free product catalog is at ?catalog=1.

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

const PRODUCTS: Record<string, string> = {
  checkcreate: "Create a Check", checkcash: "Cash a Check", checkcancel: "Cancel a Check",
  escrow: "Escrow Setup", paychannel: "Payment Channel",
  desttagreq: "Require Destination Tags", desttag: "Require Destination Tag",
  regkey: "Regular Key Rotator", rippling: "Rippling Controller",
  globalfreeze: "Global Freeze", freezeline: "Freeze a Trust Line",
  issuerdecl: "Issuer Trustless Declaration", issuercfg: "Full Issuer Config",
  dexorder: "DEX Order Builder", dextrade: "DEX Trade Execution", smartswap: "Smart Swap Router",
  ammlaunch: "AMM Pool Launch", ammentry: "AMM Liquidity Entry", tickets: "Ticket Batch Setup",
  nftmint: "NFT Minter", nftburn: "NFT Burn Certificate", nftoffer: "NFT Offer Creator",
  identity: "On-Chain Identity", did: "DID Creator", compliance: "Compliance Bundle",
  credentialissue: "Issue a Credential", permdomain: "Permissioned Domain",
};

const MAX_TAG = 4_294_967_295;
const randomTag = () => 1 + Math.floor(Math.random() * (MAX_TAG - 1));
const isAddr = (v: string) => v.startsWith("r") && v.length >= 25 && v.length <= 35;

function extractParams(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) {
    if (["productId", "account", "quoteId", "catalog"].includes(k)) continue;
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
        `Pay ${PRICE_PER_TX_PRODUCT_RLUSD} RLUSD to ${TREASURY_ADDRESS} with destination ` +
        `tag ${q.destinationTag}, then retry with the same productId + &account=<r...>&quoteId=${q.quoteId}.`,
      catalog: "GET /api/x402-tx?catalog=1 for the full product list.",
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
  const wantsCatalog = url.searchParams.get("catalog");

  // ── Free catalog ONLY when explicitly requested (?catalog=1) ────────────
  if (wantsCatalog) {
    const catalog = Object.entries(PRODUCTS).map(([id, label]) => {
      const meta = productMeta(id);
      return { productId: id, label, tier: meta.tier, requiredParams: meta.needsParams };
    });
    return NextResponse.json(
      {
        service: "XRPLHub prebuilt-transaction products",
        price: PRICE_PER_TX_PRODUCT_RLUSD.toFixed(6) + " RLUSD each",
        howItWorks:
          "GET with productId + account + params -> 402 -> pay RLUSD -> receive " +
          "ready-to-sign txjson. Sign it with your own wallet.",
        products: catalog,
      },
      { headers: { "Cache-Control": "public, max-age=300" } }
    );
  }

  // Default the probe/no-product case to a real product so a bare GET pays.
  const effectiveProduct = productId ?? "checkcreate";
  if (!PRODUCTS[effectiveProduct]) {
    return NextResponse.json(
      { error: "unknown_product", message: `No product "${effectiveProduct}". GET /api/x402-tx?catalog=1.` },
      { status: 404 }
    );
  }

  // ── PAYWALL FIRST: no quoteId -> 402 challenge (crawler hits this) ───────
  if (!quoteId) {
    let quote = null;
    for (let i = 0; i < 5 && !quote; i++) {
      try {
        quote = await prisma.invoice.create({
          data: {
            plan: `paycall:tx:${effectiveProduct}`,
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
      quoteId: quote.id, productId: effectiveProduct,
      destinationTag: quote.destinationTag, expiresAt: quote.expiresAt,
    });
  }

  // ── Paid retry: NOW require account, verify payment, build tx ───────────
  if (!account || !isAddr(account)) {
    return NextResponse.json(
      { error: "bad_request", message: "Provide account=<your XRPL wallet r...> (the signer)." },
      { status: 400 }
    );
  }

  const quote = await prisma.invoice.findUnique({ where: { id: quoteId } });
  if (!quote || quote.plan !== `paycall:tx:${effectiveProduct}`) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (quote.expiresAt < new Date() && quote.status !== "paid") {
    return NextResponse.json({ error: "quote_expired" }, { status: 410 });
  }

  if (quote.status !== "paid") {
    const match = await findPayment(quote.destinationTag, Number(quote.amountRlusd));
    if (!match.paid) {
      return paymentRequired({
        quoteId: quote.id, productId: effectiveProduct,
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

  const built = buildServiceTx(effectiveProduct, account, extractParams(url));
  if (!built.ok) {
    return NextResponse.json(
      {
        error: "build_failed", reason: built.error,
        needsParams: built.needsParams ?? [], tier: built.tier ?? null,
        note: "Payment received. Retry the same quoteId with the missing params.",
        quoteId: quote.id,
      },
      { status: 422 }
    );
  }

  return NextResponse.json(
    {
      data: {
        productId: effectiveProduct, label: built.label ?? PRODUCTS[effectiveProduct],
        tier: built.tier ?? "safe", txjson: built.txjson, signWith: account,
        instructions:
          "Sign this txjson with your own XRPL wallet and submit it. XRPLHub built it; you sign.",
      },
      paid: PRICE_PER_TX_PRODUCT_RLUSD.toFixed(6) + " RLUSD", quoteId: quote.id,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

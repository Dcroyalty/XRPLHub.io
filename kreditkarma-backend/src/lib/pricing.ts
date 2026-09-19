// src/lib/pricing.ts
// THE server-side price table — the only source of truth for what a storefront
// product costs. Nothing the client sends (amount, currency, price) is ever
// trusted; every payment is checked against this table (see paymentGate.ts).
//
// RLUSD is USD-pegged, so the RLUSD number IS the USD list price. An XRP price
// is always DERIVED from it at request time with a live XRP/USD rate — there is
// no stored XRP price to go stale (the old catalog hard-coded ~3.25 XRP per
// dollar, i.e. XRP at ~$0.31, while XRP trades near $1.44).
//
// The homepage still carries its own copy of these numbers until the pricing-
// display change lands; scripts in the repo assert the two agree.

import { xrpUsd } from "./xrpPrice";

export const TREASURY = "rs59g3amo5iT6T64Cg96XXMAWuw3WPQcLF";
export const RLUSD_ISSUER = process.env.RLUSD_ISSUER || "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
/** "RLUSD" is 5 chars, so on XRPL it is the 40-hex currency code. */
export const RLUSD_HEX = "524C555344000000000000000000000000000000";

export type PayCurrency = "XRP" | "RLUSD";

/** USD (= RLUSD) list price of each storefront service. */
export const SERVICE_PRICE_USD: Readonly<Record<string, number>> = Object.freeze({
  multisig: 60,
  regkey: 30,
  depositauth: 20,
  desttag: 15,
  issuerdecl: 40,
  tokenfee: 25,
  issuercfg: 80,
  trustline: 20,
  rippling: 20,
  dexorder: 25,
  ammlaunch: 75,
  ammentry: 35,
  smartswap: 25,
  paychannel: 50,
  nftmint: 30,
  nftburn: 20,
  nftoffer: 20,
  identity: 20,
  did: 35,
  compliance: 55,
  escrow: 40,
  mptissue: 55,
  mptsend: 20,
  trustsend: 25,
  globalfreeze: 30,
  freezeline: 25,
  checkcreate: 20,
  checkcash: 15,
  checkcancel: 15,
  desttagreq: 20,
  dextrade: 25,
  tickets: 20,
  credentialissue: 35,
  permdomain: 45,
  // Not a builder service: the paid XRPLScore credential (/api/credential).
  credential: 1,
});

/** Products that are payments but not priced services (accepted, never executable). */
export const OPEN_AMOUNT_PRODUCTS: ReadonlySet<string> = new Set(["donate"]);

export function priceUsd(productId: string): number | null {
  return Object.prototype.hasOwnProperty.call(SERVICE_PRICE_USD, productId) ? SERVICE_PRICE_USD[productId] : null;
}

// ── XRP conversion ───────────────────────────────────────────────────────────

/** +2% on the quote so a small XRP/USD drift before the buyer signs can't strand them. */
export const XRP_QUOTE_BUFFER = 1.02;
/** At verification the buyer must have paid at least this fraction of the USD price, at the CURRENT rate. */
export const XRP_VERIFY_TOLERANCE = 0.95;
const RATE_TTL_MS = 60_000;

let rateCache: { rate: number; at: number } | null = null;

/** Live XRP/USD, cached briefly so a burst of checks doesn't hammer the price sources. Throws if unavailable. */
export async function currentXrpUsd(): Promise<number> {
  if (rateCache && Date.now() - rateCache.at < RATE_TTL_MS) return rateCache.rate;
  const rate = await xrpUsd();
  rateCache = { rate, at: Date.now() };
  return rate;
}

/** Test-only: inject/clear the cached rate. */
export function _setRateForTest(rate: number | null): void {
  rateCache = rate == null ? null : { rate, at: Date.now() };
}

export class PricingError extends Error {
  constructor(public code: "unknown_product" | "xrp_price_unavailable" | "bad_currency", message: string) {
    super(message);
  }
}

export interface Quote {
  productId: string;
  currency: PayCurrency;
  /** Exact amount to send, as the decimal string the payment must carry. */
  amount: string;
  priceUsd: number;
  /** Set for XRP quotes. */
  xrpUsd: number | null;
}

/** What the server will ask this buyer to pay. Ignores anything the client claims. */
export async function quote(productId: string, currency: string): Promise<Quote> {
  const usd = priceUsd(productId);
  if (usd == null) throw new PricingError("unknown_product", `Unknown product "${productId}".`);
  if (currency === "RLUSD") return { productId, currency: "RLUSD", amount: usd.toFixed(2), priceUsd: usd, xrpUsd: null };
  if (currency !== "XRP") throw new PricingError("bad_currency", "currency must be XRP or RLUSD");
  let rate: number;
  try {
    rate = await currentXrpUsd();
  } catch {
    throw new PricingError("xrp_price_unavailable", "XRP pricing is temporarily unavailable. Please pay in RLUSD.");
  }
  const xrp = Math.ceil((usd / rate) * XRP_QUOTE_BUFFER * 1e6) / 1e6;
  return { productId, currency: "XRP", amount: xrp.toFixed(6), priceUsd: usd, xrpUsd: rate };
}

/**
 * Is `paid` (in `currency`) enough for a product priced `usd`? `rate` is the current
 * XRP/USD (required for XRP). RLUSD must cover the price exactly; XRP may be up to
 * 5% under at the current rate (the quote already carries a 2% buffer).
 */
export function isPaymentSufficient(usd: number, currency: PayCurrency, paid: number, rate: number | null): boolean {
  if (!Number.isFinite(paid) || paid <= 0) return false;
  if (currency === "RLUSD") return paid + 1e-9 >= usd;
  if (rate == null || !(rate > 0)) return false;
  return paid * rate >= usd * XRP_VERIFY_TOLERANCE;
}

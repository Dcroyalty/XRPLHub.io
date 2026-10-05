// src/lib/servicePrices.ts
// THE service price table: USD (= RLUSD) list price per storefront product. Pure data with no
// server-only imports, so the homepage can read the same numbers the server enforces.
// The server verifies every payment against THIS table (see pricing.ts / paymentGate.ts);
// an XRP price is never stored — it is derived from a live rate at request time.

/**
 * Service build prices (owner decision 2026-10-05): every standard build is $1 and every caution-tier build is $5, on every
 * rail (storefront XRP/RLUSD, x402 RLUSD, x402 USDC). Tier comes from serviceCatalog.ts; check-service-parity.mjs fails the
 * build if any price here disagrees with its tier. Was $15–$80 per service before 2026-10-05.
 */
export const STANDARD_BUILD_USD = 1;
export const CAUTION_BUILD_USD = 5;
/** Spend Controls: one plan, per month, prepaid in RLUSD (owner decision 2026-10-05). Merchants cash free. */
export const SPEND_PLAN_MONTHLY_USD = 5;

/** USD (= RLUSD) list price of each storefront service. */
export const SERVICE_PRICE_USD: Readonly<Record<string, number>> = Object.freeze({
  multisig: 5,
  regkey: 5,
  depositauth: 1,
  desttag: 1,
  issuerdecl: 5,
  tokenfee: 1,
  issuercfg: 1,
  trustline: 1,
  rippling: 1,
  dexorder: 1,
  ammlaunch: 1,
  ammentry: 1,
  smartswap: 1,
  paychannel: 1,
  nftmint: 1,
  nftburn: 1,
  nftoffer: 1,
  identity: 1,
  did: 1,
  compliance: 1,
  escrow: 1,
  mptissue: 5,
  mptsend: 1,
  trustsend: 1,
  globalfreeze: 1,
  freezeline: 1,
  checkcreate: 1,
  checkcash: 1,
  checkcancel: 1,
  depositpreauth: 1, // replaced the duplicate desttagreq (same price point)
  ammwithdraw: 1, // replaced the duplicate dextrade (same price point)
  tickets: 1,
  credentialissue: 1,
  permdomain: 1,
  delegate: 5,
  // Not a builder service: the paid XRPLScore credential (/api/credential).
  credential: 1,
});

/**
 * Admin-only products: never on the storefront, never in the public catalog (serviceCatalog.ts),
 * never counted in SERVICE_COUNT/BUILDABLE_SERVICE_IDS, never in create-payment's NAMES map.
 * check-service-parity.mjs asserts these ids are ABSENT from every customer-facing surface and
 * PRESENT with a real builder — so this can't silently become a 35th product, and can't silently
 * stop working either. Gated separately in /api/execute via isAdmin() (adminAuth.ts).
 *
 * Currently just `adminhealthcheck`: proves the real paid path (payment verification against this
 * price, single-use claim, build delivery) with a genuine on-chain payment, without touching any
 * real customer's price or count. See docs/AUTONOMY.md.
 */
export const ADMIN_ONLY_SERVICE_IDS: ReadonlySet<string> = new Set(["adminhealthcheck"]);

/** Kept OUT of SERVICE_PRICE_USD on purpose (see ADMIN_ONLY_SERVICE_IDS); priceUsd() below reads both. */
export const ADMIN_ONLY_PRICE_USD: Readonly<Record<string, number>> = Object.freeze({
  // ~$0.50 so a 1 XRP payment comfortably clears it at any realistic XRP/USD rate -- exercises the
  // SAME live-rate/tolerance logic (pricing.ts) real customers hit, not a shortcut around it.
  adminhealthcheck: 0.5,
});

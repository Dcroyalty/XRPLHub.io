// src/lib/servicePrices.ts
// THE service price table: USD (= RLUSD) list price per storefront product. Pure data with no
// server-only imports, so the homepage can read the same numbers the server enforces.
// The server verifies every payment against THIS table (see pricing.ts / paymentGate.ts);
// an XRP price is never stored — it is derived from a live rate at request time.

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
  depositpreauth: 20, // replaced the duplicate desttagreq (same price point)
  ammwithdraw: 25, // replaced the duplicate dextrade (same price point)
  tickets: 20,
  credentialissue: 35,
  permdomain: 45,
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

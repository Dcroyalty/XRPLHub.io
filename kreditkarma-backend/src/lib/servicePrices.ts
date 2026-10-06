// src/lib/servicePrices.ts
// THE service price table: USD (= RLUSD) list price per storefront product. Pure data with no
// server-only imports, so the homepage can read the same numbers the server enforces.
// The server verifies every payment against THIS table (see pricing.ts / paymentGate.ts);
// an XRP price is never stored — it is derived from a live rate at request time.

/**
 * The 35 transaction services are FREE on every path (owner decision 2026-10-05, after Xaman removed XRPLHub's original
 * app for charging for transactions Xaman offers free). Every entry for a catalog service below must be 0 —
 * check-service-parity.mjs fails the build otherwise. History: $15–$80 until 2026-10-05, then $1 / $5 for a few hours.
 * Still paid (NOT in this table's service rows): score reports + score API, screening, monitoring, MPT data, credentials
 * (`credential` below), lending/underwriting, API plans, the admin health check (ADMIN_ONLY_PRICE_USD), Spend Controls.
 */
export const TX_SERVICE_PRICE_USD = 0;
/** Spend Controls: one plan, per month, prepaid in RLUSD (owner decision 2026-10-05). Merchants cash free. */
export const SPEND_PLAN_MONTHLY_USD = 5;

/** USD (= RLUSD) list price of each storefront service. */
export const SERVICE_PRICE_USD: Readonly<Record<string, number>> = Object.freeze({
  multisig: 0,
  regkey: 0,
  depositauth: 0,
  desttag: 0,
  issuerdecl: 0,
  tokenfee: 0,
  issuercfg: 0,
  trustline: 0,
  rippling: 0,
  dexorder: 0,
  ammlaunch: 0,
  ammentry: 0,
  smartswap: 0,
  paychannel: 0,
  nftmint: 0,
  nftburn: 0,
  nftoffer: 0,
  identity: 0,
  did: 0,
  compliance: 0,
  escrow: 0,
  mptissue: 0,
  mptsend: 0,
  trustsend: 0,
  globalfreeze: 0,
  freezeline: 0,
  checkcreate: 0,
  checkcash: 0,
  checkcancel: 0,
  depositpreauth: 0,
  ammwithdraw: 0,
  tickets: 0,
  credentialissue: 0,
  permdomain: 0,
  delegate: 0,
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

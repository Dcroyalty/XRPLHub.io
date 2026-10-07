// src/lib/servicePrices.ts
// THE service price table: USD (= RLUSD) list price per storefront product. Pure data with no
// server-only imports, so the homepage can read the same numbers the server enforces.
// The server verifies every payment against THIS table (see pricing.ts / paymentGate.ts);
// an XRP price is never stored — it is derived from a live rate at request time.

/**
 * The transactions XRPLHub still builds are FREE (owner decision 2026-10-05, after Xaman removed XRPLHub's original app
 * for charging for transactions Xaman offers free). Since 2026-10-07 only the ones inside XRPLHub's own products remain
 * (the generic catalog was removed): mptissue and permdomain below — check-service-parity.mjs fails the build if either
 * is priced. Still paid: score reports + score API, screening, monitoring, MPT data, credentials (`credential` below),
 * lending/underwriting, API plans, the agent payment pre-check, the admin health check (ADMIN_ONLY_PRICE_USD).
 * Spend Controls is free (its checks are built in src/lib/checks.ts, not here).
 */
export const TX_SERVICE_PRICE_USD = 0;

/** USD (= RLUSD) list price of each product the payment gate knows. */
export const SERVICE_PRICE_USD: Readonly<Record<string, number>> = Object.freeze({
  mptissue: 0,
  permdomain: 0,
  // Not a builder service: the paid XRPLScore credential (/api/credential).
  credential: 1,
});

/**
 * Admin-only products: never on the storefront, never in the public catalog (serviceCatalog.ts),
 * never in BUILDABLE_SERVICE_IDS, never in create-payment's NAMES map.
 * check-service-parity.mjs asserts these ids are ABSENT from every customer-facing surface and
 * PRESENT with a real builder — so this can't silently become a public product, and can't silently
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

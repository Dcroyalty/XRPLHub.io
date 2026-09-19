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

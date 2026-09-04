// scripts/fund-issuer.mjs
// One-shot: build a Xaman payload that PRE-FILLS a 1.3 XRP payment to the
// dedicated credential issuer, so signing skips Xaman's compose/recipient
// screen entirely (that lookup hangs on an unactivated destination).
//
//   Run:  npx tsx scripts/fund-issuer.mjs
//
// Prints the deeplink (tap on phone -> straight to the sign screen) and the
// QR PNG URL. Uses createPayload() from src/lib/xumm.ts — same Xaman client
// the checkout flow uses (429 backoff, XUMM_API_KEY/SECRET from .env).

import "dotenv/config";
import { createPayload, xummConfigured } from "../src/lib/xumm.ts";

const ISSUER = "rmWjCGeLtuLGerEuvHDkrsr46ej2Ni13f"; // checksum-verified; EXPECTED_ISSUER in src/lib/credentials.ts
const DROPS = "1300000"; // 1.3 XRP, no destination tag

if (!xummConfigured()) {
  console.error("XUMM_API_KEY / XUMM_API_SECRET not set in .env");
  process.exit(1);
}

const txjson = {
  TransactionType: "Payment",
  Destination: ISSUER,
  Amount: DROPS,
};

console.log("txjson:", JSON.stringify(txjson));

const p = await createPayload({
  txjson,
  submit: true, // Xaman submits it to mainnet after you sign
  expireMinutes: 20,
  identifier: `xrplhub_fund_issuer_${Date.now()}`,
  instruction:
    "XRPLHub — fund the credential issuer\n1.3 XRP to rmWjCGeLtuLGerEuvHDkrsr46ej2Ni13f\nNo destination tag.",
});

console.log("\n─── Xaman payload ───────────────────────────────────────────");
console.log("  uuid       ", p.uuid);
console.log("  expires in ", p.expiresIn, "s");
console.log("\n  DEEPLINK (tap on your phone):");
console.log("  " + p.deepLink);
console.log("\n  QR PNG:");
console.log("  " + p.qrPng);
console.log("─────────────────────────────────────────────────────────────");
console.log("\nCheck status any time:");
console.log("  curl -s https://xumm.app/api/v1/platform/payload/" + p.uuid +
  ' -H "X-API-Key: $XUMM_API_KEY" -H "X-API-Secret: $XUMM_API_SECRET"');

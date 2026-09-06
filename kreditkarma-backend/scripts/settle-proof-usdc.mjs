// scripts/settle-proof-usdc.mjs
// Runs a REAL x402 payment against XRPLHub's USDC-on-Base paid routes, from
// YOUR Base wallet. Proves the CDP rail (verify + settle) and the
// verify -> handler -> settle order, end to end.
//
//   BASE_PRIVATE_KEY=0x...  node scripts/settle-proof-usdc.mjs score
//   BASE_PRIVATE_KEY=0x...  node scripts/settle-proof-usdc.mjs mpt <48-hex-issuanceId>
//
// Needs: USDC on Base at that address (>= the price + a hair). ~$0.01 per call.
// The private key is read from the env only — never written anywhere.

import { wrapFetchWithPayment, createSigner, decodeXPaymentResponse } from "x402-fetch";

const ORIGIN = process.env.PROVE_ORIGIN || "https://www.xrplhub.io";
const KEY = process.env.BASE_PRIVATE_KEY;
if (!KEY || !/^0x[0-9a-fA-F]{64}$/.test(KEY)) {
  console.error("Set BASE_PRIVATE_KEY=0x<64 hex> (your Base wallet).");
  process.exit(1);
}

const [mode, arg] = process.argv.slice(2);
const SAMPLE_WALLET = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";

let url, init;
if (mode === "score" || !mode) {
  url = `${ORIGIN}/api/x402/usdc/score`;
  init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: SAMPLE_WALLET }) };
} else if (mode === "mpt") {
  if (!/^[0-9A-Fa-f]{48}$/.test(arg || "")) { console.error("mpt mode needs a 48-hex MPTokenIssuanceID"); process.exit(1); }
  url = `${ORIGIN}/api/x402/usdc/mpt/${arg}`;
  init = { method: "GET" };
} else {
  console.error("mode must be 'score' or 'mpt <id>'"); process.exit(1);
}

const BASE_USDC_6DP_MAX = 1_000_000n; // cap the auto-payment at 1 USDC

(async () => {
  const idem = `settle-proof-${mode}-${Date.now()}`;
  console.log(`\n=== USDC-on-Base settle proof: ${mode} ===`);
  console.log("resource     :", url);
  console.log("Idempotency-Key:", idem);

  // 1) unpaid probe — inspect the challenge
  const probe = await fetch(url, { ...init });
  const challenge = await probe.json().catch(() => ({}));
  const accept = (challenge.accepts || [])[0] || {};
  console.log("\n-- 402 challenge --");
  console.log("  HTTP           :", probe.status);
  console.log("  network        :", accept.network);
  console.log("  asset          :", accept.asset);
  console.log("  payTo          :", accept.payTo);
  console.log("  maxAmountRequired:", accept.maxAmountRequired, "(6dp USDC)");
  console.log("  outputSchema in :", !!(accept.outputSchema && accept.outputSchema.input));
  console.log("  outputSchema out:", !!(accept.outputSchema && accept.outputSchema.output));

  // 2) pay + retrieve, in one wrapped call
  const signer = await createSigner("base", KEY);
  console.log("\n  paying from    :", signer.account?.address || "(signer ready)");
  const payFetch = wrapFetchWithPayment(fetch, signer, BASE_USDC_6DP_MAX);

  const t0 = Date.now();
  const res = await payFetch(url, { ...init, headers: { ...(init.headers || {}), "Idempotency-Key": idem } });
  const body = await res.json().catch(() => ({}));
  const took = ((Date.now() - t0) / 1000).toFixed(1);

  const payResp = res.headers.get("x-payment-response");
  const decoded = payResp ? safeDecode(payResp) : null;

  console.log("\n-- paid call --");
  console.log("  HTTP           :", res.status, `(${took}s)`);
  console.log("  handler result :", summarize(mode, body));
  console.log("  real result?   :", isReal(mode, body) ? "YES" : "NO");
  console.log("  x402 in body   :", JSON.stringify(body.x402 || null));
  console.log("  X-PAYMENT-RESPONSE:", decoded ? JSON.stringify(decoded) : "(none)");

  const txHash = decoded?.transaction || decoded?.txHash || body?.x402?.transaction || null;
  console.log("\n  SETTLEMENT TX  :", txHash || "(not reported)");
  if (txHash) {
    console.log("  verify on BaseScan: https://basescan.org/tx/" + txHash);
    console.log("  -> a USDC Transfer of ~" + (Number(accept.maxAmountRequired || 0) / 1e6) + " to " + accept.payTo + " on Base confirms settlement.");
  }

  console.log("\n-- verdict --");
  console.log("  rail proven    :", res.status === 200 && isReal(mode, body) ? "YES — verify+handler+settle all fired" : "NO");
  if (res.status !== 200) console.log("  NOTE: non-200 — inspect `error`:", body.error, body.message);
})().catch((e) => { console.error("\nFAILED:", e.message); process.exit(1); });

function safeDecode(h) { try { return decodeXPaymentResponse(h); } catch { try { return JSON.parse(Buffer.from(h, "base64").toString()); } catch { return null; } } }
function summarize(mode, b) {
  if (mode === "mpt") return `found=${b.found} tier=${b.tier} issuer=${b.issuer} score=${b.issuerRisk?.xrplScore}`;
  const d = b.data || b;
  return `score=${d.score} grade=${d.grade} signals=${d.signals ? Object.keys(d.signals).length : 0}`;
}
function isReal(mode, b) {
  if (mode === "mpt") return typeof b.found === "boolean" && !!b.source;
  const d = b.data || b;
  return typeof d.score === "number" && d.score >= 300 && !!d.signals;
}

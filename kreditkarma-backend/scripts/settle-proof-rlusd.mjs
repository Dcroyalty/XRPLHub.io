// scripts/settle-proof-rlusd.mjs
// Runs a REAL x402 v2 payment against XRPLHub's RLUSD/t54 paid routes, from
// YOUR XRPL wallet. Proves the serveX402Paid restructure — verify -> HANDLER
// -> settle — with real money: the handler result comes back BEFORE the
// on-ledger payment is submitted, and settlement only fires on handler success.
//
//   PROVE_XRPL_SEED=s...  node scripts/settle-proof-rlusd.mjs score
//   PROVE_XRPL_SEED=s...  node scripts/settle-proof-rlusd.mjs report
//
// Needs: an activated XRPL account with an RLUSD trustline and >= the price
// (0.02 RLUSD for score, 0.08 for report). The seed is read from env only.

import { Client, Wallet } from "xrpl";

const ORIGIN = process.env.PROVE_ORIGIN || "https://www.xrplhub.io";
const SEED = process.env.PROVE_XRPL_SEED;
if (!SEED) { console.error("Set PROVE_XRPL_SEED=s... (your XRPL wallet — needs an RLUSD trustline + balance)."); process.exit(1); }

const mode = process.argv[2] || "score";
const RESOURCE = mode === "report" ? "/api/x402/report" : "/api/x402/score";
const SAMPLE_WALLET = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
const RLUSD_HEX = "524C555344000000000000000000000000000000";

const b64 = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");

(async () => {
  const wallet = Wallet.fromSeed(SEED);
  const idem = `settle-proof-rlusd-${mode}-${Date.now()}`;
  const url = `${ORIGIN}${RESOURCE}?wallet=${SAMPLE_WALLET}`;
  console.log(`\n=== RLUSD/t54 settle proof: ${mode} ===`);
  console.log("resource      :", url);
  console.log("buyer         :", wallet.classicAddress);
  console.log("Idempotency-Key:", idem);

  // 1) challenge
  const probe = await fetch(url);
  const challenge = await probe.json();
  const req = challenge.accepts[0];
  console.log("\n-- 402 challenge --");
  console.log("  HTTP          :", probe.status);
  console.log("  payTo         :", req.payTo);
  console.log("  amount        :", req.amount, "RLUSD (issuer " + req.extra.issuer + ")");
  console.log("  invoiceId     :", req.extra.invoiceId);
  console.log("  outputSchema  :", (req.outputSchema && req.outputSchema.input) ? "input+output embedded" : "MISSING");

  // 2) pre-flight: does the buyer hold RLUSD?
  const c = new Client("wss://xrplcluster.com", { timeout: 20000 });
  await c.connect();
  try {
    const lines = await c.request({ command: "account_lines", account: wallet.classicAddress, peer: req.extra.issuer });
    const rl = (lines.result.lines || []).find((l) => l.currency === RLUSD_HEX || l.currency === "RLUSD");
    console.log("\n-- buyer RLUSD --");
    console.log("  trustline     :", rl ? "yes" : "NO — create a trustline to " + req.extra.issuer + " for RLUSD first");
    console.log("  balance       :", rl ? rl.balance : "0");
    if (!rl || Number(rl.balance) < Number(req.amount)) {
      console.log("\nSTOP: insufficient RLUSD to run this proof. Acquire >= " + req.amount + " RLUSD (trustline + balance) and retry.");
      process.exit(2);
    }

    // 3) build + sign the exact-scheme Payment. Amount.value MUST equal req.amount exactly.
    const payment = {
      TransactionType: "Payment",
      Account: wallet.classicAddress,
      Destination: req.payTo,
      Amount: { currency: RLUSD_HEX, issuer: req.extra.issuer, value: req.amount },
      SourceTag: req.extra.sourceTag,
      ...(req.extra.destinationTag ? { DestinationTag: req.extra.destinationTag } : {}),
    };
    const prepared = await c.autofill(payment);
    const signed = wallet.sign(prepared);
    console.log("\n-- signed (NOT yet submitted by us) --");
    console.log("  local tx hash :", signed.hash);

    // 4) x402 v2 payload -> PAYMENT-SIGNATURE header, paid retry
    const payload = {
      x402Version: 2,
      accepted: req,
      payload: { signedTxBlob: signed.tx_blob },
      resource: challenge.resource,
    };
    const t0 = Date.now();
    const res = await fetch(url, { headers: { "PAYMENT-SIGNATURE": b64(payload), "Idempotency-Key": idem } });
    const body = await res.json();
    const took = ((Date.now() - t0) / 1000).toFixed(1);

    console.log("\n-- paid call --");
    console.log("  HTTP          :", res.status, `(${took}s)`);
    console.log("  error         :", body.error || "(none)");
    console.log("  handler result:", mode === "report"
      ? `score=${body.data?.score} riskFlags=${(body.data?.riskFlags || []).length} snapshot=${!!body.data?.snapshot}`
      : `score=${body.data?.score} grade=${body.data?.grade} signals=${body.data?.signals ? Object.keys(body.data.signals).length : 0}`);
    console.log("  real result?  :", (typeof body.data?.score === "number" && body.data.score >= 300) ? "YES" : "NO");
    console.log("  x402          :", JSON.stringify(body.x402 || null));

    const settleTx = body.x402?.transaction || null;
    console.log("\n  SETTLEMENT TX :", settleTx || "(none — settled:" + body.x402?.settled + ")");
    if (settleTx) {
      // 5) independently confirm the settled tx on-ledger
      const txr = await c.request({ command: "tx", transaction: settleTx }).catch(() => null);
      const meta = txr?.result?.meta;
      console.log("  on-ledger     :", meta ? `${meta.TransactionResult} (validated=${txr.result.validated})` : "not found");
      console.log("  moved         :", txr?.result ? JSON.stringify(txr.result.Amount) + " -> " + txr.result.Destination : "?");
      console.log("  explorer      : https://livenet.xrpl.org/transactions/" + settleTx);
    }
    if (settleTx === signed.hash) {
      console.log("\n  NOTE: settlement tx == the tx we signed. That is the exact-scheme design —");
      console.log("        WE never submitted it; the facilitator did, AFTER computeScore returned.");
    }

    console.log("\n-- verdict --");
    const ok = res.status === 200 && typeof body.data?.score === "number" && body.x402?.settled === true && !!settleTx;
    console.log("  verify->handler->settle proven with real money:", ok ? "YES" : "NO");
    if (body.error === "handler_failed") console.log("  (handler_failed path: check body.retry — you were NOT charged, no settlement tx.)");
  } finally {
    await c.disconnect().catch(() => {});
  }
})().catch((e) => { console.error("\nFAILED:", e.message); process.exit(1); });

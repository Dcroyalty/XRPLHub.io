#!/usr/bin/env node
// scripts/setup-multisig.js
// Run AFTER generate-treasury.js and funding the treasury account
// Run: node scripts/setup-multisig.js

require("dotenv").config();
const { Client, Wallet, TrustSet, SignerListSet } = require("xrpl");

async function main() {
  const nodeUrl = process.env.XRPL_NODE_URL ?? "wss://s.altnet.rippletest.net:51233";
  const client = new Client(nodeUrl);
  await client.connect();

  console.log(`\n[XRPL] Connected to ${nodeUrl}`);

  // ── Validate env ─────────────────────────────────────────────────────────
  const required = [
    "TREASURY_ADDRESS",
    "TREASURY_SIGNER_1_SEED",
    "TREASURY_SIGNER_2_SEED",
  ];

  for (const key of required) {
    if (!process.env[key]) {
      console.error(`Missing env: ${key}`);
      process.exit(1);
    }
  }

  const treasuryAddress = process.env.TREASURY_ADDRESS;
  const signer1 = Wallet.fromSeed(process.env.TREASURY_SIGNER_1_SEED);
  const signer2 = Wallet.fromSeed(process.env.TREASURY_SIGNER_2_SEED);
  const signer3Seed = process.env.TREASURY_SIGNER_3_SEED;
  const signer3 = signer3Seed ? Wallet.fromSeed(signer3Seed) : null;
  const quorum = Number(process.env.TREASURY_QUORUM ?? 2);

  // We need the MASTER wallet to set up the signer list
  // After multi-sig is set up, the master key can be disabled
  const masterSeed = process.env.TREASURY_MASTER_SEED ?? process.env.TREASURY_SIGNER_1_SEED;
  const masterWallet = Wallet.fromSeed(masterSeed);

  console.log(`\nTreasury: ${treasuryAddress}`);
  console.log(`Signer 1: ${signer1.address}`);
  console.log(`Signer 2: ${signer2.address}`);
  if (signer3) console.log(`Signer 3: ${signer3.address}`);
  console.log(`Quorum: ${quorum}-of-${signer3 ? 3 : 2}`);

  // ── Step 1: Set up signer list ────────────────────────────────────────────
  console.log("\n[1/2] Setting up multi-sig signer list...");

  const signerEntries = [
    { SignerEntry: { Account: signer1.address, SignerWeight: 1 } },
    { SignerEntry: { Account: signer2.address, SignerWeight: 1 } },
    ...(signer3 ? [{ SignerEntry: { Account: signer3.address, SignerWeight: 1 } }] : []),
  ];

  const signerListTx = {
    TransactionType: "SignerListSet",
    Account: masterWallet.address,
    SignerQuorum: quorum,
    SignerEntries: signerEntries,
  };

  const preparedSL = await client.autofill(signerListTx);
  const signedSL = masterWallet.sign(preparedSL);
  const slResult = await client.submitAndWait(signedSL.tx_blob);

  if (slResult.result.meta?.TransactionResult === "tesSUCCESS") {
    console.log(`  ✅ Signer list configured! TX: ${slResult.result.hash}`);
  } else {
    console.error("  ❌ Signer list failed:", slResult.result.meta?.TransactionResult);
    await client.disconnect();
    process.exit(1);
  }

  // ── Step 2: Set up RLUSD trust line ───────────────────────────────────────
  console.log("\n[2/2] Setting up RLUSD trust line...");

  // Ripple's real mainnet RLUSD issuer (never an xrpl.org tutorial address).
  const rlusdIssuer = process.env.RLUSD_ISSUER ?? "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
  // "RLUSD" is 5 chars; the standard slot is 3. It MUST be the 40-char hex.
  const rlusdCurrencyHex = "524C555344000000000000000000000000000000";

  const trustLineTx = {
    TransactionType: "TrustSet",
    Account: masterWallet.address,
    LimitAmount: {
      currency: rlusdCurrencyHex,
      issuer: rlusdIssuer,
      value: "1000000",
    },
  };

  const preparedTL = await client.autofill(trustLineTx);
  const signedTL = masterWallet.sign(preparedTL);
  const tlResult = await client.submitAndWait(signedTL.tx_blob);

  if (tlResult.result.meta?.TransactionResult === "tesSUCCESS") {
    console.log(`  ✅ RLUSD trust line set! TX: ${tlResult.result.hash}`);
  } else {
    console.error("  ❌ Trust line failed:", tlResult.result.meta?.TransactionResult);
  }

  await client.disconnect();

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("   SETUP COMPLETE!");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`\n  Treasury: https://testnet.xrpl.org/accounts/${masterWallet.address}`);
  console.log("\n  Next: Fund the treasury with RLUSD to start issuing grants.");
  console.log("  Testnet RLUSD: Use the XRPL testnet AMM or faucet.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

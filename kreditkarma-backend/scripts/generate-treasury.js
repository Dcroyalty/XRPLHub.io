#!/usr/bin/env node
// scripts/generate-treasury.js
// Run: node scripts/generate-treasury.js
// Generates 3 signer wallets + 1 treasury account for multi-sig setup

const { Wallet } = require("xrpl");

console.log("═══════════════════════════════════════════════════════════");
console.log("   XRPLHub.io — Treasury Multi-Sig Key Generation");
console.log("═══════════════════════════════════════════════════════════\n");

// Treasury address (the "bank account" — holds funds)
const treasury = Wallet.generate();
console.log("┌─ TREASURY ACCOUNT (fund this address) ─────────────────┐");
console.log(`│  Address : ${treasury.address}`);
console.log(`│  Seed    : ${treasury.seed}`);
console.log("│  ⚠️  Store seed securely — used for trust line setup only");
console.log("└─────────────────────────────────────────────────────────┘\n");

// 3 signer wallets (2-of-3 required to sign transactions)
const signer1 = Wallet.generate();
const signer2 = Wallet.generate();
const signer3 = Wallet.generate();

console.log("┌─ SIGNER 1 (required) ───────────────────────────────────┐");
console.log(`│  Address : ${signer1.address}`);
console.log(`│  Seed    : ${signer1.seed}`);
console.log("└─────────────────────────────────────────────────────────┘\n");

console.log("┌─ SIGNER 2 (required) ───────────────────────────────────┐");
console.log(`│  Address : ${signer2.address}`);
console.log(`│  Seed    : ${signer2.seed}`);
console.log("└─────────────────────────────────────────────────────────┘\n");

console.log("┌─ SIGNER 3 (optional backup) ────────────────────────────┐");
console.log(`│  Address : ${signer3.address}`);
console.log(`│  Seed    : ${signer3.seed}`);
console.log("└─────────────────────────────────────────────────────────┘\n");

console.log("═══════════════════════════════════════════════════════════");
console.log("   NEXT STEPS:");
console.log("═══════════════════════════════════════════════════════════");
console.log("");
console.log("1. Copy these values into your .env file:");
console.log(`   TREASURY_ADDRESS=${treasury.address}`);
console.log(`   TREASURY_SIGNER_1_SEED=${signer1.seed}`);
console.log(`   TREASURY_SIGNER_2_SEED=${signer2.seed}`);
console.log(`   TREASURY_SIGNER_3_SEED=${signer3.seed}`);
console.log(`   TREASURY_QUORUM=2`);
console.log("");
console.log("2. Fund the treasury on TESTNET:");
console.log(`   https://faucet.altnet.rippletest.net/accounts`);
console.log(`   (paste treasury address: ${treasury.address})`);
console.log("");
console.log("3. Run multi-sig + trust line setup:");
console.log("   node scripts/setup-multisig.js");
console.log("   node scripts/setup-trustlines.js");
console.log("");
console.log("4. Verify setup:");
console.log(`   https://testnet.xrpl.org/accounts/${treasury.address}`);
console.log("");
console.log("⚠️  SECURITY: Never commit seeds to git. Use a secrets manager in prod.");
console.log("═══════════════════════════════════════════════════════════\n");

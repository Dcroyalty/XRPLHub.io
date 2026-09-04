// src/lib/treasury.ts
// ─────────────────────────────────────────────────────────────────────────────
// Treasury Service
// Multi-sig 2-of-3 treasury for grant payouts + donations
// Supports both XRP and RLUSD payments
// ─────────────────────────────────────────────────────────────────────────────

import {
  Wallet,
  Client,
  Payment,
  multisign,
  TrustSet,
  SignerListSet,
  convertStringToHex,
  xrpToDrops,
} from "xrpl";
import { getXrplClient } from "./xrpl-client";
import { RLUSD_ISSUER, RLUSD_CURRENCY_HEX, isRlusdCurrency } from "./rlusd";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

export function getTreasuryConfig() {
  const address = process.env.TREASURY_ADDRESS;
  const seed1 = process.env.TREASURY_SIGNER_1_SEED;
  const seed2 = process.env.TREASURY_SIGNER_2_SEED;
  const seed3 = process.env.TREASURY_SIGNER_3_SEED; // optional
  const quorum = Number(process.env.TREASURY_QUORUM ?? 2);

  if (!address || !seed1 || !seed2) {
    throw new Error(
      "Treasury not configured. Set TREASURY_ADDRESS, TREASURY_SIGNER_1_SEED, TREASURY_SIGNER_2_SEED in .env"
    );
  }

  const signers = [
    Wallet.fromSeed(seed1),
    Wallet.fromSeed(seed2),
    ...(seed3 ? [Wallet.fromSeed(seed3)] : []),
  ];

  return { address, signers, quorum };
}

export function getRlusdConfig() {
  // One source of truth for both values (see src/lib/rlusd.ts). The currency
  // MUST be the 40-char hex — "RLUSD" is 5 chars and xrpl.js mis-serialises it
  // in a Payment/TrustSet Amount, and account_lines returns it hex-encoded so
  // a `=== "RLUSD"` comparison never matches. The issuer fallback is Ripple's
  // real mainnet RLUSD issuer, never an xrpl.org tutorial address.
  return {
    issuer: RLUSD_ISSUER,
    currency: RLUSD_CURRENCY_HEX,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Treasury Balance Check
// ─────────────────────────────────────────────────────────────────────────────

export async function getTreasuryBalance(): Promise<{
  xrp: number;
  rlusd: number;
}> {
  const xrpl = await getXrplClient();
  const { address } = getTreasuryConfig();
  const { issuer } = getRlusdConfig();

  const [accountInfo, trustLines] = await Promise.all([
    xrpl.request({
      command: "account_info",
      account: address,
      ledger_index: "validated",
    }),
    xrpl.request({
      command: "account_lines",
      account: address,
      peer: issuer,
      ledger_index: "validated",
    }),
  ]);

  const xrpDrops = (accountInfo.result.account_data as any).Balance;
  const xrpBalance = Number(xrpDrops) / 1_000_000;

  const rlusdLine = (trustLines.result.lines as any[]).find(
    (l) => isRlusdCurrency(l.currency) && l.account === issuer
  );
  const rlusdBalance = rlusdLine ? parseFloat(rlusdLine.balance) : 0;

  return { xrp: xrpBalance, rlusd: rlusdBalance };
}

// ─────────────────────────────────────────────────────────────────────────────
// Send XRP from treasury (multi-sig)
// ─────────────────────────────────────────────────────────────────────────────

export async function sendXrpFromTreasury(
  destinationAddress: string,
  amountXrp: number,
  memoText?: string
): Promise<{ txHash: string; fee: string }> {
  const xrpl = await getXrplClient();
  const { address, signers, quorum } = getTreasuryConfig();

  const fee = await xrpl.request({ command: "fee" });
  const baseFee = Number((fee.result as any).drops.base_fee);
  // Multi-sig fee = (N_signers + 1) × base_fee
  const multisigFee = (quorum + 1) * baseFee;

  // Get current sequence
  const accountInfo = await xrpl.request({
    command: "account_info",
    account: address,
    ledger_index: "current",
  });
  const sequence = (accountInfo.result.account_data as any).Sequence;

  // Get current ledger for LastLedgerSequence
  const ledger = await xrpl.request({
    command: "ledger",
    ledger_index: "current",
  });
  const currentLedger = (ledger.result as any).ledger_index;

  const memo = memoText
    ? [{ Memo: { MemoData: convertStringToHex(memoText), MemoType: convertStringToHex("KreditKarma/Grant") } }]
    : [];

  const tx: Payment = {
    TransactionType: "Payment",
    Account: address,
    Destination: destinationAddress,
    Amount: xrpToDrops(amountXrp),
    Fee: String(multisigFee),
    Sequence: sequence,
    LastLedgerSequence: currentLedger + 20,
    ...(memo.length ? { Memos: memo } : {}),
  };

  // Sign with quorum signers
  const signedTxs = signers.slice(0, quorum).map((signer) =>
    signer.sign(tx, true) // true = multi-sign
  );

  const combined = multisign(signedTxs.map((s) => s.tx_blob));
  const result = await xrpl.submitAndWait(combined);

  const txResult = (result.result as any);
  if (txResult.meta?.TransactionResult !== "tesSUCCESS") {
    throw new Error(`XRP payment failed: ${txResult.meta?.TransactionResult}`);
  }

  return {
    txHash: txResult.hash,
    fee: String(multisigFee),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Send RLUSD from treasury (multi-sig)
// ─────────────────────────────────────────────────────────────────────────────

export async function sendRlusdFromTreasury(
  destinationAddress: string,
  amountRlusd: number,
  memoText?: string
): Promise<{ txHash: string; fee: string }> {
  const xrpl = await getXrplClient();
  const { address, signers, quorum } = getTreasuryConfig();
  const { issuer, currency } = getRlusdConfig();

  const fee = await xrpl.request({ command: "fee" });
  const baseFee = Number((fee.result as any).drops.base_fee);
  const multisigFee = (quorum + 1) * baseFee;

  const accountInfo = await xrpl.request({
    command: "account_info",
    account: address,
    ledger_index: "current",
  });
  const sequence = (accountInfo.result.account_data as any).Sequence;

  const ledger = await xrpl.request({ command: "ledger", ledger_index: "current" });
  const currentLedger = (ledger.result as any).ledger_index;

  const memo = memoText
    ? [{ Memo: { MemoData: convertStringToHex(memoText), MemoType: convertStringToHex("KreditKarma/Grant") } }]
    : [];

  const tx: Payment = {
    TransactionType: "Payment",
    Account: address,
    Destination: destinationAddress,
    Amount: {
      currency,
      issuer,
      value: amountRlusd.toFixed(6),
    },
    Fee: String(multisigFee),
    Sequence: sequence,
    LastLedgerSequence: currentLedger + 20,
    ...(memo.length ? { Memos: memo } : {}),
  };

  const signedTxs = signers.slice(0, quorum).map((signer) =>
    signer.sign(tx, true)
  );

  const combined = multisign(signedTxs.map((s) => s.tx_blob));
  const result = await xrpl.submitAndWait(combined);

  const txResult = (result.result as any);
  if (txResult.meta?.TransactionResult !== "tesSUCCESS") {
    throw new Error(`RLUSD payment failed: ${txResult.meta?.TransactionResult}`);
  }

  return {
    txHash: txResult.hash,
    fee: String(multisigFee),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// One-time setup: Configure multi-sig on an existing treasury account
// Run via: node scripts/setup-multisig.js
// ─────────────────────────────────────────────────────────────────────────────

export async function setupTreasuryMultiSig(
  masterSeed: string,
  signerAddresses: string[],
  quorum: number
): Promise<string> {
  const xrpl = await getXrplClient();
  const masterWallet = Wallet.fromSeed(masterSeed);

  const signerEntries = signerAddresses.map((addr) => ({
    SignerEntry: {
      Account: addr,
      SignerWeight: 1,
    },
  }));

  const tx: SignerListSet = {
    TransactionType: "SignerListSet",
    Account: masterWallet.address,
    SignerQuorum: quorum,
    SignerEntries: signerEntries,
  };

  const prepared = await xrpl.autofill(tx);
  const signed = masterWallet.sign(prepared);
  const result = await xrpl.submitAndWait(signed.tx_blob);

  const txResult = (result.result as any);
  if (txResult.meta?.TransactionResult !== "tesSUCCESS") {
    throw new Error(`Multi-sig setup failed: ${txResult.meta?.TransactionResult}`);
  }

  return txResult.hash;
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup RLUSD trust line on treasury
// ─────────────────────────────────────────────────────────────────────────────

export async function setupRlusdTrustLine(masterSeed: string): Promise<string> {
  const xrpl = await getXrplClient();
  const wallet = Wallet.fromSeed(masterSeed);
  const { issuer, currency } = getRlusdConfig();

  const tx: TrustSet = {
    TransactionType: "TrustSet",
    Account: wallet.address,
    LimitAmount: {
      currency,
      issuer,
      value: "1000000", // $1M limit
    },
  };

  const prepared = await xrpl.autofill(tx);
  const signed = wallet.sign(prepared);
  const result = await xrpl.submitAndWait(signed.tx_blob);

  const txResult = (result.result as any);
  if (txResult.meta?.TransactionResult !== "tesSUCCESS") {
    throw new Error(`Trust line setup failed: ${txResult.meta?.TransactionResult}`);
  }

  return txResult.hash;
}

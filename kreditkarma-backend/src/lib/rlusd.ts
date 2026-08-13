// lib/rlusd.ts
// RLUSD constants + payment verification for the XRPLScore checkout.
//
// TWO THINGS IN HERE ARE NON-NEGOTIABLE — they are what the dead-chat
// version got wrong, and they are the difference between "works" and
// "exchange gets drained":
//
//   1. The currency code is the 40-char HEX, never the string "RLUSD".
//      "RLUSD" is 5 characters; the XRPL standard code slot is 3 chars.
//      Anything longer MUST be a 160-bit (40 hex char) code. Passing
//      "RLUSD" to xrpl.js fails or mis-serializes.
//
//   2. Incoming payments are read from meta.delivered_amount, NEVER
//      from tx.Amount (a.k.a. DeliverMax in API v2). With the partial-
//      payment flag set, Amount can claim $2,000 while a fraction of a
//      cent actually lands. Reading the wrong field is the documented
//      way XRPL exchanges have been drained.
//
// Verified against XRPL.org + Ripple docs, Aug 2026.

import { Client, type TransactionMetadata } from "xrpl";

// Ripple's official RLUSD MAINNET issuer. (Testnet is a different address.)
export const RLUSD_ISSUER =
  process.env.RLUSD_ISSUER ?? "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";

// ASCII "RLUSD" = 52 4C 55 53 44, right-padded with zeros to 40 hex chars.
// Padding is on the RIGHT. Reversing this makes a different, wrong token.
export const RLUSD_CURRENCY_HEX =
  "524C555344000000000000000000000000000000";

// Your treasury wallet (the one already holding RLUSD). NOT the issuer.
export const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS ?? "";

// Public XRPL cluster by default; override with your own node if you have one.
export const XRPL_ENDPOINT =
  process.env.XRPL_ENDPOINT ?? "wss://xrplcluster.com";

/**
 * Pull the RLUSD amount that ACTUALLY arrived out of transaction metadata.
 * Returns the delivered RLUSD value as a number, or null if this tx did
 * not deliver RLUSD (wrong currency, XRP, pre-2014 "unavailable", etc.).
 *
 * This is the exploit guard. Do not "simplify" it to read tx.Amount.
 */
export function deliveredRlusd(meta: TransactionMetadata | undefined): number | null {
  const d = (meta as unknown as { delivered_amount?: unknown })?.delivered_amount;

  // Pre-2014 validated ledgers can report the string "unavailable".
  if (d === undefined || d === null || d === "unavailable") return null;

  // A bare string here means XRP (drops), not an issued token — reject.
  if (typeof d === "string") return null;

  const amt = d as { currency?: string; issuer?: string; value?: string };

  // Match issuer + the 40-char hex. Some tools decode the hex to "RLUSD";
  // accept either form defensively, but the ledger returns the hex.
  const currencyOk =
    amt.currency === RLUSD_CURRENCY_HEX || amt.currency === "RLUSD";
  const issuerOk = amt.issuer === RLUSD_ISSUER;

  if (currencyOk && issuerOk && amt.value) {
    const v = parseFloat(amt.value);
    return Number.isFinite(v) ? v : null;
  }
  return null;
}

export interface PaymentMatch {
  paid: boolean;
  txHash?: string;
  deliveredRlusd?: number;
  destinationTag?: number;
}

/**
 * Look for a settled RLUSD payment to the treasury carrying `destinationTag`
 * that delivered at least `expectedRlusd`. Serverless-safe: opens a client,
 * queries account_tx, closes. No long-lived socket required.
 */
export async function findPayment(
  destinationTag: number,
  expectedRlusd: number,
  opts: { treasury?: string; endpoint?: string; ledgerLookback?: number } = {}
): Promise<PaymentMatch> {
  const treasury = opts.treasury ?? TREASURY_ADDRESS;
  if (!treasury) throw new Error("TREASURY_ADDRESS is not set");

  const client = new Client(opts.endpoint ?? XRPL_ENDPOINT);
  await client.connect();
  try {
    const resp = await client.request({
      command: "account_tx",
      account: treasury,
      ledger_index_min: -1,
      ledger_index_max: -1,
      binary: false,
      limit: 200, // recent history is enough for an open invoice
      forward: false,
    });

    const txns = (resp.result as { transactions?: unknown[] }).transactions ?? [];

    for (const entry of txns as Array<Record<string, unknown>>) {
      // xrpl.js has shifted shapes across versions: tx | tx_json, and
      // meta | metaData. Read all of them.
      const tx = (entry.tx ?? entry.tx_json) as Record<string, unknown> | undefined;
      const meta = (entry.meta ?? entry.metaData) as TransactionMetadata | undefined;
      if (!tx || !meta) continue;

      if (tx.TransactionType !== "Payment") continue;
      if (tx.Destination !== treasury) continue;
      if (Number(tx.DestinationTag) !== destinationTag) continue;

      // Only count fully-successful transactions.
      const code = (meta as unknown as { TransactionResult?: string }).TransactionResult;
      if (code !== "tesSUCCESS") continue;

      const delivered = deliveredRlusd(meta);
      if (delivered !== null && delivered + 1e-6 >= expectedRlusd) {
        return {
          paid: true,
          txHash: (tx.hash as string) ?? (entry.hash as string),
          deliveredRlusd: delivered,
          destinationTag,
        };
      }
    }
    return { paid: false };
  } finally {
    await client.disconnect();
  }
}

/**
 * Fields a human needs to pay an invoice by hand (exchange withdrawal, or a
 * wallet without a deeplink). This is the "manual-pay panel" data.
 */
export function manualPayFields(amountRlusd: number, destinationTag: number) {
  return {
    address: TREASURY_ADDRESS,
    destinationTag,
    amount: amountRlusd.toFixed(6),
    currency: "RLUSD",
    currencyHex: RLUSD_CURRENCY_HEX,
    issuer: RLUSD_ISSUER,
    warning:
      "Destination tag is REQUIRED. A payment without this exact tag cannot be matched to your order.",
  };
}

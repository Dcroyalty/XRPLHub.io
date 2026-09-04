// src/lib/wallet/tx.ts
// Build the Payment txjson an injected wallet submits. The wallet autofills
// Account / Sequence / Fee / LastLedgerSequence. RLUSD amount is the 40-char
// hex object; XRP amount is a drops string.

import type { PaymentContext } from "./types";

const RLUSD_HEX = "524C555344000000000000000000000000000000";

export function buildPaymentTx(ctx: PaymentContext): Record<string, unknown> {
  const tx: Record<string, unknown> = {
    TransactionType: "Payment",
    Destination: ctx.to,
    Amount:
      ctx.currency === "XRP"
        ? String(Math.round(parseFloat(ctx.amount) * 1_000_000))
        : {
            currency: ctx.currencyHex || RLUSD_HEX,
            issuer: ctx.issuer,
            value: ctx.amount,
          },
  };
  if (ctx.destinationTag != null) tx.DestinationTag = ctx.destinationTag;
  return tx;
}

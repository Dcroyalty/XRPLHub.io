// src/lib/wallet/types.ts
// Wallet-agnostic signing layer. One interface; Xaman is one provider, the
// browser-extension wallets sit behind the same shape.
//
// Two flows, both server-verified:
//   proveControl  -> SignIn / free-key claim. Resolves to the exact JSON body
//                    to POST to /api/free-key/claim.
//   submitPayment -> checkout + the 35 products. Resolves to what the payment
//                    status endpoints need to confirm on-ledger.

export type WalletId = "xaman" | "crossmark" | "gemwallet";

export interface WalletMeta {
  id: WalletId;
  label: string;
  /** where to get it, shown when isAvailable() is false */
  installUrl?: string;
  /** Xaman works on any device (QR / deeplink); extensions are desktop-only */
  kind: "remote" | "extension";
}

/** What the flow hands a provider to start a SignIn. */
export interface ProveContext {
  /** server-issued single-use challenge (all providers) */
  challengeId: string;
  challengeHex: string;
  /** Xaman SignIn payload, when Xaman is configured (Xaman provider only) */
  xamanUuid?: string | null;
  xamanQrPng?: string | null;
  xamanDeepLink?: string | null;
}

export interface ProveHandle {
  /** shown by the flow while waiting (Xaman); null for extensions */
  qrPng: string | null;
  deepLink: string | null;
  /** resolves to the body for POST /api/free-key/claim, or rejects on user-cancel */
  body: Promise<Record<string, unknown>>;
}

export interface PaymentContext {
  /** what is being paid — exactly one is set */
  invoiceId?: string;               // checkout
  productId?: string;               // one of the 35 services

  to: string;                       // treasury
  amount: string;                   // decimal string, in `currency` units
  currency: "XRP" | "RLUSD";
  issuer?: string | null;           // RLUSD issuer (RLUSD only)
  currencyHex?: string | null;      // 40-char hex for RLUSD
  destinationTag?: number | null;   // checkout invoices; omitted for the 35 products
}

export interface PaymentHandle {
  qrPng: string | null;
  deepLink: string | null;
  /** resolves once the payment is broadcast (not yet confirmed):
   *   { via: "xaman", uuid }  -> flow polls the existing Xaman status endpoint
   *   { via: "injected", txHash } -> flow polls with ?hash= */
  result: Promise<{ via: "xaman"; uuid: string } | { via: "injected"; txHash: string }>;
}

export interface WalletProvider extends WalletMeta {
  /** true only if this wallet can be used in THIS browser right now */
  isAvailable(): Promise<boolean>;
  proveControl(ctx: ProveContext): ProveHandle;
  /** convenience: build + submit a Payment to the treasury */
  submitPayment(ctx: PaymentContext): PaymentHandle;
  /** sign + submit an arbitrary txjson (the 35 service transactions).
   *  Xaman: not supported here — the server builds its own payload. */
  submitTx?(txjson: Record<string, unknown>): Promise<{ txHash: string }>;
}

export class WalletCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "WalletCancelled";
  }
}
export class WalletError extends Error {}

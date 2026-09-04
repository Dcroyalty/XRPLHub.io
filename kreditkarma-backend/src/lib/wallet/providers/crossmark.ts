// src/lib/wallet/providers/crossmark.ts
// Crossmark browser extension — @crossmarkio/sdk@0.4.0 (pinned; SDK is frozen).
// Dynamically imported so it stays out of the initial bundle.
//
//   proveControl : sdk.async.signInAndWait(challengeHex) -> { address, publicKey, signature }
//                  server verifies the signature recovers to `address`.
//   submitPayment: sdk.async.signAndSubmitAndWait(txjson) -> { resp: { hash } }
//                  server verifies that tx on-ledger (destination, amount, tesSUCCESS).

import type {
  WalletProvider,
  ProveContext,
  ProveHandle,
  PaymentContext,
  PaymentHandle,
} from "../types";
import { WalletCancelled, WalletError } from "../types";
import { buildPaymentTx } from "../tx";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadSdk(): Promise<any> {
  const mod = await import("@crossmarkio/sdk");
  return (mod as { default: unknown }).default;
}

async function signAndSubmit(txjson: Record<string, unknown>): Promise<{ txHash: string }> {
  const sdk = await loadSdk();
  let r: unknown;
  try {
    r = await sdk.async.signAndSubmitAndWait(txjson);
  } catch {
    throw new WalletCancelled();
  }
  const resp = (r as { response?: { data?: { resp?: { hash?: string }; hash?: string } } })
    ?.response?.data;
  const hash = resp?.resp?.hash ?? resp?.hash;
  if (!hash) throw new WalletError("Crossmark did not return a transaction hash.");
  return { txHash: hash };
}

export const crossmarkProvider: WalletProvider = {
  id: "crossmark",
  label: "Crossmark",
  kind: "extension",
  installUrl: "https://crossmark.io",

  async isAvailable() {
    // Lightweight: the Crossmark extension injects window.crossmark. Checking
    // the global avoids loading the SDK just to detect. The SDK is loaded only
    // when the wallet is actually used.
    if (typeof window === "undefined") return false;
    return Boolean((window as unknown as { crossmark?: unknown }).crossmark);
  },

  proveControl(ctx: ProveContext): ProveHandle {
    const body = (async (): Promise<Record<string, unknown>> => {
      const sdk = await loadSdk();
      let r: unknown;
      try {
        r = await sdk.async.signInAndWait(ctx.challengeHex);
      } catch {
        throw new WalletCancelled();
      }
      const data = (r as { response?: { data?: Record<string, unknown> } })?.response?.data;
      const address = data?.address as string | undefined;
      const publicKey = data?.publicKey as string | undefined;
      const signature = data?.signature as string | undefined;
      if (!address || !publicKey || !signature) {
        throw new WalletError("Crossmark did not return a signature.");
      }
      return {
        walletId: "crossmark",
        challengeId: ctx.challengeId,
        address,
        publicKey,
        signature,
      };
    })();
    return { qrPng: null, deepLink: null, body };
  },

  submitTx: signAndSubmit,

  submitPayment(ctx: PaymentContext): PaymentHandle {
    const result = (async (): Promise<{ via: "injected"; txHash: string }> => {
      const { txHash } = await signAndSubmit(buildPaymentTx(ctx));
      return { via: "injected", txHash };
    })();
    return { qrPng: null, deepLink: null, result };
  },
};

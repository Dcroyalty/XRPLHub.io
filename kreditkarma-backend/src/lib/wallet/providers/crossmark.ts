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
import { pollFor } from "../detect";

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
    // The Crossmark EXTENSION injects `window.xrpl.isCrossmark` (the SDK only
    // later mirrors it onto `window.crossmark`). Poll for it — the content
    // script often injects a beat after the page's own scripts. No SDK load
    // needed to detect.
    if (typeof window === "undefined") return false;
    const has = () => {
      const w = window as unknown as {
        xrpl?: { isCrossmark?: boolean };
        crossmark?: unknown;
      };
      return Boolean(w.xrpl?.isCrossmark || w.crossmark);
    };
    // Crossmark's content script injects at document_start; 1.5s is ample and
    // keeps the picker snappy for users without it.
    return pollFor(has, 1500);
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

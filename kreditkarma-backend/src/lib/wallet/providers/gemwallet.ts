// src/lib/wallet/providers/gemwallet.ts
// GemWallet browser extension — @gemwallet/api@3.8.0 (pinned; SDK is frozen).
// Dynamically imported so it stays out of the initial bundle.
//
//   proveControl : getPublicKey() -> { address, publicKey }
//                  signMessage(challengeHex, true) -> { signedMessage }
//                  server verifies the signature recovers to `address`.
//   submitPayment: submitTransaction({ transaction: txjson }) -> { hash }
//                  server verifies that tx on-ledger.

import type {
  WalletProvider,
  ProveContext,
  ProveHandle,
  PaymentContext,
  PaymentHandle,
} from "../types";
import { WalletCancelled, WalletError } from "../types";
import { buildPaymentTx } from "../tx";

async function loadApi() {
  return import("@gemwallet/api");
}

async function signAndSubmit(txjson: Record<string, unknown>): Promise<{ txHash: string }> {
  const { submitTransaction } = await loadApi();
  let r: Awaited<ReturnType<typeof submitTransaction>>;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    r = await submitTransaction({ transaction: txjson as any });
  } catch {
    throw new WalletCancelled();
  }
  if (r?.type !== "response" || !r.result?.hash) {
    throw new WalletError("GemWallet did not return a transaction hash.");
  }
  return { txHash: r.result.hash };
}

export const gemwalletProvider: WalletProvider = {
  id: "gemwallet",
  label: "GemWallet",
  kind: "extension",
  installUrl: "https://gemwallet.app",

  async isAvailable() {
    // The GemWallet extension injects window.gemWallet. Confirm with the SDK's
    // isInstalled() (message round-trip) only if the global looks present, so
    // we don't load the SDK on every page.
    if (typeof window === "undefined") return false;
    if (!(window as unknown as { gemWallet?: unknown }).gemWallet) return false;
    try {
      const { isInstalled } = await loadApi();
      const r = await isInstalled();
      return r?.result?.isInstalled === true;
    } catch {
      return false;
    }
  },

  proveControl(ctx: ProveContext): ProveHandle {
    const body = (async (): Promise<Record<string, unknown>> => {
      const { getPublicKey, signMessage } = await loadApi();

      const pk = await getPublicKey();
      if (pk?.type !== "response" || !pk.result?.publicKey || !pk.result?.address) {
        throw new WalletCancelled();
      }
      const sig = await signMessage(ctx.challengeHex, true /* isHex */);
      if (sig?.type !== "response" || !sig.result?.signedMessage) {
        throw new WalletCancelled();
      }
      return {
        walletId: "gemwallet",
        challengeId: ctx.challengeId,
        address: pk.result.address,
        publicKey: pk.result.publicKey,
        signature: sig.result.signedMessage,
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
